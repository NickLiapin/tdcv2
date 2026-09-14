/**
 * How the work is divided — every decision, and none of the doing.
 *
 * `parallel.ts` and `parquet-parallel.ts` spawn worker threads, write temp files and concatenate
 * them, so the only honest way to exercise them is the way an editor exercises a language server:
 * end to end, as a real process. `test/cli/parallel.test.ts` does exactly that — byte-identical
 * output at one, four and seven workers, a uniq group split and still distinct, a valid Parquet
 * file across worker counts — but it runs the built CLI as a CHILD PROCESS, so none of it counts
 * towards coverage. Those two files read 39% and 3% while being covered end to end, the same lie
 * `sequence/composed.ts` told at 26% before the shared fixtures moved under vitest.
 *
 * They are excluded from coverage now, as `lsp/server-impl.ts` is. This module is what that
 * exclusion must not swallow: the arithmetic and the refusals, which are decisions rather than
 * plumbing, and which a unit test can reach without spawning anything.
 *
 * Nothing here touches a thread, a file or the clock. The one function that parses does so to
 * ANSWER a question — how many row groups are there, can this config be split — and answers it
 * in this process.
 */

import { parseStrict } from '../parser/index.js';
import {
  hasInlineRenderGenerators,
  hasPerRowAssertion,
  hasUnsplittableUniqueness,
} from '../processor/render.js';
import { parquetRowGroupCount } from '../output/render-parquet.js';

/** What the workers have finished between them. */
export function total(counts: readonly number[]): number {
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
  if (hasPerRowAssertion(document)) {
    return 'the config has an <assert each="…">, and its message names the first failing row — across workers "first" would be whichever thread reached one, so the same run would name a different row each time';
  }
  return undefined;
}

/**
 * Below this row count, splitting across worker threads costs more (thread
 * spawn + temp files + ordered concatenation) than it saves — auto mode stays
 * single-threaded under it.
 *
 * It was 100_000 and that was far too low. Measured on twelve cores, a config
 * of two short fields:
 *
 *   1,000,000 rows   parallel 8.38 s / 2897 MB   serial 4.29 s /  701 MB
 *   2,000,000 rows   parallel 9.06 s / 3701 MB   serial 7.04 s /  701 MB
 *   4,000,000 rows   parallel 7.21 s / 4970 MB   serial 13.09 s / 712 MB
 *
 * Below three million the split lost on BOTH counts: slower AND four times
 * heavier, because every worker keeps its own heap. Spawning eleven workers,
 * writing their temp files and concatenating them in order costs a few seconds
 * whatever the config, and under three million rows there is not enough work to
 * pay it back. (The clearest sign of that fixed price: the parallel run of four
 * million rows finished FASTER than the parallel run of two million.)
 *
 * One number cannot be right for every config, and this one is a deliberate
 * compromise rather than a measurement. A heavier config — six fields drawing
 * from packs — crosses over near three hundred thousand rows, ten times lower,
 * so between there and three million it now runs on one thread: about 1.4x
 * slower and five times lighter. That is the safer default of the two. A run
 * that is slower still finishes; a run that wanted 5 GB on a laptop does not,
 * and nothing in the row count warned anybody.
 *
 * The honest fix is to stop guessing from the row count and measure the config
 * — time a short probe render and extrapolate, since what actually decides this
 * is how long the serial run would take, not how many rows it has. That was
 * prototyped and NOT shipped: the probe has to exclude one-off setup (parsing,
 * scanning a hundred locale packs) or it overestimates several-fold, and once
 * that is excluded the probe still cost 2.8 s on a 4.5 s run. It needs a proper
 * benchmark harness rather than a calibration against noisy numbers.
 */
export const AUTO_JOBS_MIN_ROWS = 3_000_000;

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

/** Contiguous, balanced group ranges covering `[0, groups)`. */
export function partitionGroups(
  groups: number,
  jobs: number,
): readonly (readonly [number, number])[] {
  const j = Math.max(1, Math.min(jobs, Math.max(1, groups)));
  const base = Math.floor(groups / j);
  const remainder = groups % j;
  const ranges: [number, number][] = [];
  let start = 0;
  for (let k = 0; k < j; k++) {
    const end = start + base + (k < remainder ? 1 : 0);
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

/**
 * How many workers a Parquet run can actually use. Never more than there are
 * row groups — a worker with no groups would only cost a thread.
 */
export function parquetJobLimit(source: string, jobs: number, now: number, seed: string): number {
  const groups = parquetRowGroupCount(parseStrict(source), { now, seed });
  return Math.max(1, Math.min(jobs, groups));
}
