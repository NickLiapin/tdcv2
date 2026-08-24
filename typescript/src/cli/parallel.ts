/**
 * Parallel generation coordinator (`--jobs N`).
 *
 * Splits `[0, count)` into N contiguous ranges, renders each in a worker
 * thread to its own temp file, then concatenates the temp files IN ORDER to
 * the destination. Because Engine 2's value(i) is seekable, the workers need
 * no coordination and the concatenation is byte-identical to a single-threaded
 * `--jobs 1` run. A pure speed knob — it never changes the output.
 *
 * Only sound when: the streaming engine is active AND there are no inline
 * render-time generators (those draw from the sequential render prng — see
 * `hasInlineRenderGenerators`). The caller checks `parallelBlockReason` first
 * and falls back to single-threaded generation when it returns a reason.
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { writeAllSync } from '../output/write-all.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  hasInlineRenderGenerators,
  hasUniqueness,
  checkUniqFeasible,
  envUniqGroupsOf,
  hasUnsplittableUniqueness,
  renderStream,
} from '../processor/render.js';
import { bundledPacksDir, scanPacks } from '../data-pack/load.js';
import type { UniqArrangement, UniqPlan } from '../sequence/build.js';
import { parseStrict } from '../parser/index.js';

import type { RenderWorkerInput } from './render-worker.js';
import type { ScanWorkerInput } from './scan-worker.js';
import type { PileWorkerInput } from './pile-worker.js';
import { bucketCountFor } from '../sequence/fingerprint.js';

const WORKER_PATH = fileURLToPath(new URL('./render-worker.js', import.meta.url));
const SCAN_WORKER_PATH = fileURLToPath(new URL('./scan-worker.js', import.meta.url));
const PILE_WORKER_PATH = fileURLToPath(new URL('./pile-worker.js', import.meta.url));
const CONCAT_BUFFER_BYTES = 1 << 20;

export interface ParallelParams {
  readonly source: string;
  readonly seed: string;
  readonly count: number;
  /**
   * An OVERRIDE the caller actually asked for, never a default. `undefined`
   * means "whatever the config says", and it has to survive as `undefined` all
   * the way into the worker — filling it in with 'en' here is what made a
   * `local="ru"` config produce English data above the auto-parallel threshold.
   */
  readonly locale: string | undefined;
  /** The project config's locale: a fallback for a config that names none. */
  readonly defaultLocale?: string | undefined;
  readonly now: number;
  readonly dataPaths?: readonly string[] | undefined;
  readonly baseDir?: string | undefined;
  readonly jobs: number;
  /** Destination file descriptor (1 for stdout, or an opened output file). */
  readonly destFd: number;
  /**
   * Called as the run advances, with the WHOLE file's numbers.
   *
   * Every worker reports the rows it has finished; this adds them up, so a
   * watcher sees one run rather than N. Without it a parallel run was silent
   * until the moment it ended — and above a hundred thousand rows the CLI
   * chooses parallel by itself, which made silence the ordinary case.
   */
  readonly onProgress?:
    | ((progress: {
        phase: 'uniq-scan' | 'uniq-sort' | 'uniq-repair' | 'render';
        done: number;
        total: number;
      }) => void)
    | undefined;
}

/** What the workers have finished between them. */
function total(counts: readonly number[]): number {
  let sum = 0;
  for (const n of counts) sum += n;
  return sum;
}

/**
 * Why `source` cannot be range-parallelized, or `undefined` if it can. The
 * caller has already confirmed the streaming engine is active; this checks the
 * seekability precondition (no inline render-time generators).
 */
export function parallelBlockReason(source: string): string | undefined {
  const document = parseStrict(source);
  if (hasInlineRenderGenerators(document)) {
    return 'the config has an inline <gen>/<switch> in a <block>/fixture line (not in a <sequence>), which draws from the sequential render RNG and cannot be split across workers';
  }
  if (hasUnsplittableUniqueness(document)) {
    return 'the config has uniq="true" on a sequence, which rearranges the generators inside one compound column — a worker resolving a row on its own cannot reproduce that';
  }
  return undefined;
}

/**
 * Below this row count, splitting across worker threads costs more (thread
 * spawn + temp files + ordered concatenation) than it saves — auto mode stays
 * single-threaded under it.
 */
export const AUTO_JOBS_MIN_ROWS = 100_000;

/**
 * Decide how many worker threads to use. An explicit `--jobs` is honored
 * verbatim (the caller still gates on feasibility and reports if it can't run).
 * Otherwise AUTO: use `cores - 1` (leave one core for the OS/user) when the
 * config can be split and the file is big enough to pay back the overhead —
 * else a single thread. Safe to choose by hardware because the job count NEVER
 * changes the output (unlike the engine, which must be chosen by config).
 */
export function resolveJobCount(params: {
  readonly explicit: number | undefined;
  readonly canParallelize: boolean;
  readonly count: number;
  readonly cores: number;
  readonly minRows?: number;
}): number {
  if (params.explicit !== undefined) return params.explicit;
  const minRows = params.minRows ?? AUTO_JOBS_MIN_ROWS;
  if (!params.canParallelize || params.count < minRows) return 1;
  return Math.max(1, params.cores - 1);
}

/** Contiguous, balanced ranges covering `[0, count)` — the first `count % jobs` get one extra row. */
export function partitionRows(count: number, jobs: number): readonly (readonly [number, number])[] {
  const j = Math.max(1, Math.min(jobs, Math.max(1, count)));
  const base = Math.floor(count / j);
  const remainder = count % j;
  const ranges: [number, number][] = [];
  let start = 0;
  for (let k = 0; k < j; k++) {
    const end = start + base + (k < remainder ? 1 : 0);
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

/** Render in parallel to `destFd`. Resolves when the full output has been written. */
/**
 * Work out the uniq arrangement once, here, so no worker has to.
 *
 * Deciding which rows a uniq group moves where is a pass over every row to find
 * the collisions and a second to learn which tuples are taken — the expensive
 * half of a uniq run, and the same answer every time for a given config and
 * seed. Eleven workers each repeating it would make splitting the file slower
 * than not splitting it.
 *
 * The render is asked for an EMPTY range: the registry is built, which is where
 * the arrangement is decided, and not one row is produced. Returns undefined
 * for a config with no uniq group, which is most of them.
 */
function planUniq(
  params: ParallelParams,
  fingerprints: Readonly<Record<string, readonly string[]>>,
  excess: Readonly<Record<string, readonly number[]>>,
): UniqPlan | undefined {
  const document = parseStrict(params.source);
  if (!hasUniqueness(document)) return undefined;

  const roots = [bundledPacksDir(), ...(params.dataPaths ?? [])].filter(
    (p): p is string => p !== undefined,
  );
  const plan: Record<string, UniqArrangement> = {};
  for (const _chunk of renderStream(document, {
    seed: params.seed,
    count: params.count,
    ...(params.locale !== undefined ? { locale: params.locale } : {}),
    ...(params.defaultLocale !== undefined ? { defaultLocale: params.defaultLocale } : {}),
    packs: scanPacks(roots).registry,
    now: params.now,
    mode: 'disk',
    dataPaths: params.dataPaths,
    baseDir: params.baseDir,
    source: params.source,
    range: { start: 0, end: 0 },
    ...(Object.keys(fingerprints).length > 0 ? { uniqFingerprintFiles: fingerprints } : {}),
    ...(Object.keys(excess).length > 0 ? { uniqExcess: excess } : {}),
    onUniqPlan: (group, arrangement) => {
      plan[group] = arrangement;
    },
  })) {
    // Nothing is asked for; the registry is what this call is here to build.
  }
  return plan;
}

export async function runParallel(params: ParallelParams): Promise<void> {
  // Said before anything is spawned, so the status file EXISTS from the first
  // moment. Starting a dozen workers takes seconds on a large config, and a
  // watcher that finds no file cannot tell "not started yet" from "died".
  params.onProgress?.({ phase: 'render', done: 0, total: params.count });
  const ranges = partitionRows(params.count, params.jobs);
  const dir = mkdtempSync(join(tmpdir(), 'tdc-parallel-'));
  const scanDir = join(dir, 'scan');
  let uniqPlan: UniqPlan | undefined;
  const tmpPaths = ranges.map((_, k) => join(dir, `range-${String(k)}.txt`));

  try {
    /*
     * Phase one: the scan, split the same way the render is.
     *
     * Computing every row's tuple and sorting them is the largest single stage
     * of a uniq run — 23 minutes of 61 at 97,000,000 rows — and it was the last
     * part still running on one core. Each worker produces exactly the records
     * the whole-file scan would produce for its range; the arrangement is then
     * worked out once, here, from everyone's files merged.
     */
    const piles = await scanInParallel(params, ranges, scanDir);
    // Phase two of the hunt: each pile is sorted and scanned by its own
    // thread, and matching fingerprints come back as CANDIDATE row groups.
    // Verification recomputes the true tuples for those few rows, so a hash
    // collision costs a lookup and never a false duplicate.
    const found = await excessFromPiles(params, piles, scanDir);
    uniqPlan = planUniq(params, found.fingerprints, found.excess);

    // Phase two: the rows themselves, every worker holding the arrangement.
    // The analysis is over and the rows are about to start. Said by the
    // coordinator, because the stretch between the last pile and the first
    // worker report is the repair — real work with no phase of its own, and
    // without this mark the file would sit on "uniq-sort" through all of it.
    params.onProgress?.({ phase: 'render', done: 0, total: params.count });
    const rendered = new Array<number>(ranges.length).fill(0);
    await Promise.all(
      ranges.map(([start, end], k) => {
        const input: RenderWorkerInput = {
          source: params.source,
          seed: params.seed,
          count: params.count,
          locale: params.locale,
          defaultLocale: params.defaultLocale,
          now: params.now,
          dataPaths: params.dataPaths,
          baseDir: params.baseDir,
          start,
          end,
          tmpPath: tmpPaths[k] ?? join(dir, `range-${String(k)}.txt`),
          ...(uniqPlan !== undefined ? { uniqPlan } : {}),
        };
        return runWorker(input, (rows) => {
          rendered[k] = rows;
          params.onProgress?.({ phase: 'render', done: total(rendered), total: params.count });
        });
      }),
    );

    // Concatenate the ranges IN ORDER — this is what makes the output identical.
    const buffer = Buffer.allocUnsafe(CONCAT_BUFFER_BYTES);
    for (const tmpPath of tmpPaths) concatFileToFd(tmpPath, params.destFd, buffer);
  } finally {
    // retries: workers have exited, but the OS may briefly hold a handle.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Hash every range's tuples into fingerprint piles, in parallel.
 *
 * Returns, per uniq group, one entry per pile holding the files every thread
 * wrote into it. Empty for a config with no env-level `<uniq>` — then the
 * analysis has nothing to do and this costs one parse. Empty too below a
 * million rows, where the coordinator's own render analyses the run faster
 * than piles pay for themselves.
 */
async function scanInParallel(
  params: ParallelParams,
  ranges: readonly (readonly [number, number])[],
  scanDir: string,
): Promise<Record<string, readonly (readonly string[])[]>> {
  const document = parseStrict(params.source);
  const groups = envUniqGroupsOf(document);
  if (groups.length === 0) return {};

  /*
   * Is the config even possible, before threads are told to scan it?
   *
   * The check is cheap — it counts what each column can produce, no rows
   * generated — and a group asking for more distinct rows than its values
   * allow is refused by it. Left until after the scan, an impossible config
   * spent every core computing tuples for an answer that could never exist.
   */
  checkUniqFeasible(document, params.count);

  const buckets = bucketCountFor(params.count, params.jobs);
  if (buckets < 2) return {};

  const piles: Record<string, readonly (readonly string[])[]> = {};
  for (const members of groups) {
    // One slot per worker, so a later report from a worker REPLACES its earlier
    // one instead of being added to it. Adding deltas would need the workers to
    // send deltas, and a dropped message would then be lost for good.
    const scanned = new Array<number>(ranges.length).fill(0);
    const perRange = await Promise.all(
      ranges.map(([start, end], k) =>
        runScanWorker(
          {
            source: params.source,
            seed: params.seed,
            count: params.count,
            locale: params.locale,
            defaultLocale: params.defaultLocale,
            now: params.now,
            dataPaths: params.dataPaths,
            baseDir: params.baseDir,
            members,
            start,
            end,
            dir: scanDir,
            prefix: `g${String(groups.indexOf(members))}-r${String(k)}`,
            buckets,
          },
          (rows) => {
            scanned[k] = rows;
            params.onProgress?.({
              phase: 'uniq-scan',
              done: total(scanned),
              total: params.count,
            });
          },
        ).then((r) => r.paths ?? []),
      ),
    );
    /*
     * Each thread wrote one file per pile, so a pile's records are spread
     * across as many files as there were threads. Regroup them: pile b is
     * every thread's b-th file. Nothing is read or copied — only the paths
     * are rearranged. The engine names a group by its members joined with
     * ' × '; the key has to match or the files would be computed and then
     * quietly ignored.
     */
    piles[members.join(' × ')] = Array.from({ length: buckets }, (_, b) =>
      perRange.map((paths) => paths[b]).filter((path): path is string => path !== undefined),
    );
  }
  return piles;
}

/**
 * Sort and scan every pile in parallel, verify the candidates, and return the
 * verified excess plus the sorted pile files per group.
 *
 * The sorted files are not a by-product: the repair binary-searches them to
 * answer "is this tuple taken?", so they ARE the ledger and must reach the
 * plan render via `uniqFingerprintFiles`.
 */
async function excessFromPiles(
  params: ParallelParams,
  piles: Record<string, readonly (readonly string[])[]>,
  tmpDir: string,
): Promise<{
  readonly fingerprints: Record<string, readonly string[]>;
  readonly excess: Record<string, readonly number[]>;
}> {
  const fingerprints: Record<string, readonly string[]> = {};
  const excess: Record<string, readonly number[]> = {};

  for (const [label, files] of Object.entries(piles)) {
    const sortedPaths = files.map((_, b) =>
      join(tmpDir, `${label.replace(/[^\w]+/g, '_')}-sorted-${String(b)}`),
    );
    let sorted = 0;
    const perPile = await Promise.all(
      files.map((paths, b) =>
        runPileWorker({ paths, outPath: sortedPaths[b] ?? '', tmpDir }).then((candidates) => {
          // Counted as piles FINISH, not as they start: a pile that is still
          // being sorted is not progress, and Promise.all would report them in
          // the order they were created rather than the order they completed.
          sorted += 1;
          params.onProgress?.({ phase: 'uniq-sort', done: sorted, total: files.length });
          return candidates;
        }),
      ),
    );
    fingerprints[label] = sortedPaths;

    const candidates = perPile.flat();
    if (candidates.length === 0) {
      excess[label] = [];
      continue;
    }
    /*
     * Verify: matching fingerprints are candidates, not verdicts. One worker
     * recomputes the true tuples for the handful of candidate rows; rows whose
     * tuples genuinely repeat — beyond the first of each, lowest spared — are
     * the excess, ascending, exactly as the text scan would have named them.
     */
    const rows = candidates.flat();
    const verified = await runScanWorker({
      source: params.source,
      seed: params.seed,
      count: params.count,
      locale: params.locale,
      defaultLocale: params.defaultLocale,
      now: params.now,
      dataPaths: params.dataPaths,
      baseDir: params.baseDir,
      members: label.split(' × '),
      verifyIndices: rows,
    });
    const keyOf = new Map(verified.pairs ?? []);
    const out: number[] = [];
    for (const group of candidates) {
      const byKey = new Map<string, number[]>();
      for (const row of group) {
        const key = keyOf.get(row) ?? '';
        const held = byKey.get(key);
        if (held) held.push(row);
        else byKey.set(key, [row]);
      }
      for (const same of byKey.values()) {
        if (same.length < 2) continue;
        same.sort((a, b) => a - b);
        for (let m = 1; m < same.length; m++) {
          const row = same[m];
          if (row !== undefined) out.push(row);
        }
      }
    }
    out.sort((a, b) => a - b);
    excess[label] = out;
  }
  return { fingerprints, excess };
}

/** Run one pile worker: sort the pile, return the candidate row groups. */
function runPileWorker(input: PileWorkerInput): Promise<readonly (readonly number[])[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PILE_WORKER_PATH, { workerData: input });
    let result: { ok: boolean; error?: string; candidates?: (readonly number[])[] } | undefined;
    let earlyError: Error | undefined;
    worker.on('message', (msg: typeof result) => {
      result = msg;
    });
    worker.on('error', (err: Error) => {
      earlyError = err;
    });
    worker.on('exit', (code) => {
      if (earlyError) reject(earlyError);
      else if (result && !result.ok) reject(new Error(result.error ?? 'pile worker failed'));
      else if (code !== 0) reject(new Error(`pile worker stopped with exit code ${String(code)}`));
      else resolve(result?.candidates ?? []);
    });
  });
}

/** Run one scan worker; the result carries pile paths (scan job) or tuple pairs (verify job). */
function runScanWorker(
  input: ScanWorkerInput,
  onRows?: (rows: number) => void,
): Promise<{ paths?: readonly string[]; pairs?: [number, string][] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SCAN_WORKER_PATH, { workerData: input });
    let result:
      | { ok: boolean; error?: string; paths?: readonly string[]; pairs?: [number, string][] }
      | undefined;
    let earlyError: Error | undefined;
    worker.on('message', (msg: (typeof result & { rows?: number }) | undefined) => {
      if (msg?.rows !== undefined) {
        onRows?.(msg.rows);
        return;
      }
      result = msg;
    });
    worker.on('error', (err: Error) => {
      earlyError = err;
    });
    // Settle on exit, so the files are closed before anyone reads or removes them.
    worker.on('exit', (code) => {
      if (earlyError) reject(earlyError);
      else if (result && !result.ok) reject(new Error(result.error ?? 'scan worker failed'));
      else if (code !== 0) reject(new Error(`scan worker stopped with exit code ${String(code)}`));
      else
        resolve({
          ...(result?.paths ? { paths: result.paths } : {}),
          ...(result?.pairs ? { pairs: result.pairs } : {}),
        });
    });
  });
}

function runWorker(input: RenderWorkerInput, onRows?: (rows: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: input });
    let result: { ok: boolean; error?: string } | undefined;
    let earlyError: Error | undefined;
    worker.on('message', (msg: { ok?: boolean; error?: string; rows?: number }) => {
      // A message carrying `rows` is progress, not the outcome. Treating every
      // message as the result would leave `result` holding a row count, and the
      // worker's real answer would be the one thing nobody read.
      if (msg.rows !== undefined) {
        onRows?.(msg.rows);
        return;
      }
      result = msg as { ok: boolean; error?: string };
    });
    worker.on('error', (err: Error) => {
      earlyError = err;
    });
    // Settle on `exit` only, so the worker has fully released its temp-file
    // handle before we concatenate and clean up (avoids ENOTEMPTY on rmdir).
    worker.on('exit', (code) => {
      if (earlyError) reject(earlyError);
      else if (result && !result.ok) reject(new Error(result.error ?? 'worker failed'));
      else if (code !== 0) reject(new Error(`worker stopped with exit code ${String(code)}`));
      else resolve();
    });
  });
}

function concatFileToFd(srcPath: string, destFd: number, buffer: Buffer): void {
  const src = openSync(srcPath, 'r');
  try {
    let bytesRead = readSync(src, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      // `destFd` is 1 when there is no `-o`, so this is a pipe as often as
      // not — it must write the whole slice, not whatever the pipe had room
      // for. See output/write-all.ts.
      writeAllSync(destFd, buffer.subarray(0, bytesRead));
      bytesRead = readSync(src, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(src);
  }
}
