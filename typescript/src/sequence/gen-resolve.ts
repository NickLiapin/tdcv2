/**
 * Per-row seekable resolution of an independent generator, for the streaming
 * engines. Extracted from build.ts (the in-RAM bulk builder) so that file stays
 * focused; these are the row-at-a-time twins the streaming layer calls.
 */

import { seekableGen } from '../prng/seekable.js';
import { buildGenValues, streamCtx, type SequenceBuildOptions } from './build.js';
import type { GenSpec } from './types.js';

/**
 * Resolve one value of an independent gen at row `i` off a seekable per-row
 * PRNG draw. Reuses all generator logic (number ranges, dates, regex, symbols,
 * template/data-list picks) so nothing is duplicated in the streaming layer.
 * Not for counters (those depend on `i` directly — resolve them separately).
 */
export function resolveGenValueAt(
  gen: GenSpec,
  i: number,
  seed: string,
  streamId: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
): string {
  return (
    buildGenValues(gen, 1, seekableGen(seed, streamId, i), locale, now, streamCtx(options))[0] ?? ''
  );
}

/**
 * Whether row `i` of an independent-path gen was selected as an anomaly — the
 * seekable twin of `resolveGenValueAt`, for the `anomaly_flag` column in the
 * streaming engines. Re-runs the same per-row build so the flag reflects exactly
 * the draw that spiked (or didn't spike) the value.
 */
export function resolveGenAnomalyFlagAt(
  gen: GenSpec,
  i: number,
  seed: string,
  streamId: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
): boolean {
  return resolveGenAnomalyFlagTextAt(gen, i, seed, streamId, locale, now, options) === 'true';
}

/**
 * The anomaly label for row `i` as TEXT. With `repeat` this is a LIST parallel
 * to the value list (`"false,true,false"`), so the label says WHICH element of
 * the batch was the outlier — not merely that the batch contained one. Without
 * `repeat` it is plain `"true"`/`"false"`.
 */
export function resolveGenAnomalyFlagTextAt(
  gen: GenSpec,
  i: number,
  seed: string,
  streamId: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
): string {
  const flags: string[] = [];
  buildGenValues(gen, 1, seekableGen(seed, streamId, i), locale, now, streamCtx(options), flags);
  return flags[0] ?? 'false';
}
