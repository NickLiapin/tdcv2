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

const WORKER_PATH = fileURLToPath(new URL('./render-worker.js', import.meta.url));
const SCAN_WORKER_PATH = fileURLToPath(new URL('./scan-worker.js', import.meta.url));
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
  scans: Readonly<Record<string, readonly string[]>>,
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
    ...(Object.keys(scans).length > 0 ? { uniqScans: scans } : {}),
    onUniqPlan: (group, arrangement) => {
      plan[group] = arrangement;
    },
  })) {
    // Nothing is asked for; the registry is what this call is here to build.
  }
  return plan;
}

export async function runParallel(params: ParallelParams): Promise<void> {
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
    const scans = await scanInParallel(params, ranges, scanDir);
    uniqPlan = planUniq(params, scans);

    // Phase two: the rows themselves, every worker holding the arrangement.
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
        return runWorker(input);
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
 * Compute the tuple records for every range, in parallel, and return the run
 * files per uniq group.
 *
 * Empty for a config with no env-level `<uniq>`, which is most of them — then
 * the analysis has nothing to do and this costs one parse.
 */
async function scanInParallel(
  params: ParallelParams,
  ranges: readonly (readonly [number, number])[],
  scanDir: string,
): Promise<Record<string, readonly string[]>> {
  const document = parseStrict(params.source);
  const groups = envUniqGroupsOf(document);
  if (groups.length === 0) return {};

  /*
   * Is the config even possible, before eleven threads are told to scan it?
   *
   * The check is cheap — it counts what each column can produce, no rows
   * generated — and a group asking for more distinct rows than its values allow
   * is refused by it. Left until after the scan, an impossible config spent
   * every core computing tuples for an answer that could never exist, and the
   * refusal arrived once they were done.
   */
  checkUniqFeasible(document, params.count);

  const scans: Record<string, readonly string[]> = {};
  for (const members of groups) {
    const perRange = await Promise.all(
      ranges.map(([start, end], k) =>
        runScanWorker({
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
        }),
      ),
    );
    // The engine names a group by its members joined this way; the key has to
    // match or the files would be computed and then quietly ignored.
    scans[members.join(' × ')] = perRange.flat();
  }
  return scans;
}

/** Run one scan worker and collect the run files it wrote. */
function runScanWorker(input: ScanWorkerInput): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolve, reject) => {
    const worker = new Worker(SCAN_WORKER_PATH, { workerData: input });
    let result: { ok: boolean; error?: string; paths?: readonly string[] } | undefined;
    let earlyError: Error | undefined;
    worker.on('message', (msg: { ok: boolean; error?: string; paths?: readonly string[] }) => {
      result = msg;
    });
    worker.on('error', (err: Error) => {
      earlyError = err;
    });
    // Settle on exit, as the render workers do, so the files are closed before
    // anyone reads or removes them.
    worker.on('exit', (code) => {
      if (earlyError) reject(earlyError);
      else if (result && !result.ok) reject(new Error(result.error ?? 'scan worker failed'));
      else if (code !== 0) reject(new Error(`scan worker stopped with exit code ${String(code)}`));
      else resolve(result?.paths ?? []);
    });
  });
}

function runWorker(input: RenderWorkerInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: input });
    let result: { ok: boolean; error?: string } | undefined;
    let earlyError: Error | undefined;
    worker.on('message', (msg: { ok: boolean; error?: string }) => {
      result = msg;
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
