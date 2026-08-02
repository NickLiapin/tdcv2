/**
 * Streaming value(i) resolvers — compute a single row's value on demand for
 * Engine 2, using the seekable PRNG and the Feistel permutation. Pure: no
 * context, no arrays of length `count`. See
 * `docs/superpowers/specs/2026-07-14-engine2-streaming-impl.md`.
 *
 * - **Exact percent** — place a sorted Hamilton quota plan by `permute(i)`.
 *   The bijection sends exactly the first `counts[0]` indices into the first
 *   category's slot range, so the distribution is byte-exact with NO array
 *   (a "lottery with no tumbler").
 * - **Uniform list pick** — an independent seekable draw per row.
 * - **Counters** — pure functions of `i`.
 *
 * The list-agnostic generators (number ranges, dates, regex, symbols) are
 * resolved at the integration layer by reusing the existing generator on a
 * per-row seekable draw, so their logic is not duplicated here.
 */

import { permute } from '../prng/permute.js';
import { seekableInt } from '../prng/seekable.js';

/** Category index (into a quota plan) for row `i` under exact percentages. */
export function percentCategoryAt(
  counts: readonly number[],
  count: number,
  key: number,
  i: number,
): number {
  const slot = permute(i, count, key);
  let acc = 0;
  for (let c = 0; c < counts.length; c++) {
    acc += counts[c] ?? 0;
    if (slot < acc) return c;
  }
  return Math.max(0, counts.length - 1);
}

/**
 * Exact-percentage value for row `i` from parallel `values`/`counts` arrays
 * (`counts` = Hamilton quotas from `computeCountsPerValue`, summing to
 * `count`). The result distribution is exact over the whole dataset.
 */
export function percentValueAt(
  values: readonly string[],
  counts: readonly number[],
  count: number,
  key: number,
  i: number,
): string {
  return values[percentCategoryAt(counts, count, key, i)] ?? '';
}

/**
 * A reusable exact-% resolver `value(i)` that precomputes the cumulative quota
 * bounds ONCE and binary-searches per row — O(log #values), vs `percentValueAt`
 * which rescans linearly each call. Matters for WIDE columns (many values, e.g.
 * a uniq column with a value per row): rendering drops from O(count²) to
 * O(count·log). Identical result to `percentValueAt`.
 */
export function makePercentResolver(
  values: readonly string[],
  counts: readonly number[],
  count: number,
  key: number,
): (i: number) => string {
  const n = counts.length;
  const cumHi = new Array<number>(n); // value c owns slots [cumHi[c-1], cumHi[c])
  let acc = 0;
  for (let c = 0; c < n; c++) {
    acc += counts[c] ?? 0;
    cumHi[c] = acc;
  }
  return (i: number): string => {
    const slot = permute(i, count, key);
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (slot < (cumHi[mid] ?? 0)) hi = mid;
      else lo = mid + 1;
    }
    return values[lo] ?? '';
  };
}

/** Uniform pick from `values` for row `i` (independent seekable draw). */
export function uniformValueAt(
  values: readonly string[],
  seed: string,
  streamId: string,
  i: number,
): string {
  if (values.length === 0) return '';
  return values[seekableInt(seed, streamId, i, values.length)] ?? '';
}

/** `increment` / `decrement` value for row `i` (pure). */
export function counterValueAt(
  kind: 'increment' | 'decrement',
  start: number,
  step: number,
  i: number,
): number {
  return kind === 'decrement' ? start - i * step : start + i * step;
}
