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

import { hasInlineRenderGenerators, hasUniqueness } from '../processor/render.js';
import { parseStrict } from '../parser/index.js';

import type { RenderWorkerInput } from './render-worker.js';

const WORKER_PATH = fileURLToPath(new URL('./render-worker.js', import.meta.url));
const CONCAT_BUFFER_BYTES = 1 << 20;

export interface ParallelParams {
  readonly source: string;
  readonly seed: string;
  readonly count: number;
  readonly locale: string | undefined;
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
  if (hasUniqueness(document)) {
    return 'the config asks for uniqueness (uniq="true", or a <uniq> group), which is a promise about the whole dataset — a worker sees only its own range of rows and could not tell a duplicate outside it from a value it has never seen';
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
export async function runParallel(params: ParallelParams): Promise<void> {
  const ranges = partitionRows(params.count, params.jobs);
  const dir = mkdtempSync(join(tmpdir(), 'tdc-parallel-'));
  const tmpPaths = ranges.map((_, k) => join(dir, `range-${String(k)}.txt`));

  try {
    await Promise.all(
      ranges.map(([start, end], k) => {
        const input: RenderWorkerInput = {
          source: params.source,
          seed: params.seed,
          count: params.count,
          locale: params.locale ?? 'en',
          now: params.now,
          dataPaths: params.dataPaths,
          baseDir: params.baseDir,
          start,
          end,
          tmpPath: tmpPaths[k] ?? join(dir, `range-${String(k)}.txt`),
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
