/**
 * How the in-memory engine derives a column the way the streaming engine does.
 *
 * The two engines were built on different ideas of randomness. Engine 1 threaded
 * one PRNG through every sequence in declaration order, so a column's values
 * depended on how many draws the columns before it had made; engines 2 and 3
 * derive each cell from `(seed, streamId, row)` and are independent of one
 * another. Two architectures, and no seed could ever make them agree.
 *
 * This module is engine 1 adopting the second scheme. It holds the three pieces
 * that decide how: which generators may be built row by row, what a column is
 * called on the wire, and the exact layout a list of values gets.
 */

import { computeCountsPerValue } from '../distribution/hamilton.js';
import { expandPercentMask } from '../distribution/percent-mask.js';
import { permute, permuteKey } from '../prng/permute.js';
import { createPrng } from '../prng/prng.js';

import type { SequenceBuildContext } from './context.js';
import type { GenSpec } from './types.js';

/**
 * The same context, told which column it is building.
 *
 * Independent generators derive from `(seed, streamId, row)` so this engine and
 * the streaming one agree; everything else ignores it. A fresh object rather
 * than a mutable field — two columns must never see each other's name.
 *
 * The mask, when the column has one, records the ABSOLUTE row each drawn
 * position belongs to. See `rows` on the context for why that matters.
 */
export function forStreamOf(
  ctx: SequenceBuildContext,
  streamId: string,
  mask?: readonly boolean[],
): SequenceBuildContext {
  // A mask that lets every row through is no mask at all; leaving `rows`
  // undefined then keeps the common case free of an array nobody reads.
  const rows = mask?.some((on) => !on) === true ? rowsOf(mask) : undefined;
  return { ...ctx, streamId, rows };
}

/** The absolute row index of each position a masked column draws. */
function rowsOf(mask: readonly boolean[]): number[] {
  const rows: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) rows.push(i);
  return rows;
}

/**
 * Generators whose value for a row depends on nothing but that row. The
 * streaming engine already builds these one row at a time; this list is what
 * lets the in-memory engine do the same.
 *
 * Excluded on purpose, and each because it is a PLAN over the whole column
 * rather than a draw per row — make one of these per-row and its proportions
 * stop being exact: `percent=` on any type, `weight=` on a file column, a
 * weighted choice inside `advanced_regex`, and the shares a pack can declare
 * for a `template`. `text` is excluded for the same reason from the other
 * side: even an UNWEIGHTED list is spread evenly over the column and permuted,
 * never picked independently per row, so `exactTextLayout` below handles it
 * instead of this path.
 */
const PER_ROW_TYPES: ReadonlySet<string> = new Set(['number', 'regex', 'symbol', 'date']);

/** Can this generator be built row by row? `count <= 1` is already one row. */
export function perRowBuildable(gen: GenSpec, count: number, ctx: SequenceBuildContext): boolean {
  if (count <= 1 || ctx.seed === undefined || ctx.streamId === undefined) return false;
  if (!PER_ROW_TYPES.has(gen.type)) return false;
  // `order="sequential"` reads the position, never the randomness.
  if (gen.attrs['order'] === 'sequential') return false;
  // `percent=` on ANY type, not just text: a number can apportion its LENGTH
  // groups the same exact way (`length="2,10-12" percent="85,15"`), and reading
  // this as a text-only attribute turned a 15% group into 0% of the rows.
  if (gen.attrs['percent'] !== undefined) return false;
  // `repeat=` apportions the LENGTHS exactly across the column — how many rows
  // get two elements, how many get five. That plan lives in `buildRepeatedValues`,
  // and taking the per-row path would skip it: a 15% length group came out as
  // 0% of the rows.
  if (gen.attrs['repeat'] !== undefined) return false;
  return true;
}

/**
 * A list of values laid out exactly, the way the streaming engine lays it out.
 *
 * `computeCountsPerValue` turns the shares into a whole number of slots per
 * value; `permute` scatters those slots over the rows with a key derived from
 * the column's name. Row i gets the value whose slot range contains
 * `permute(i)`. Both halves are keyed by `(seed, streamId)`, so the in-memory
 * and the streaming engine land on the same arrangement.
 *
 * `percents` may be given directly — a weighted file column or a pack that
 * declares shares arrives with its own — otherwise `percentAttr` is expanded,
 * and an absent one means equal shares. The streaming engine has no separate
 * uniform path, so neither does this: uniform IS the exact layout, evenly cut.
 *
 * Returns undefined when this run cannot do it — no seed or no column name (an
 * inline generator, or a nested build) — and the caller keeps the old draw.
 */
export function exactTextLayout(
  values: readonly string[],
  percentAttr: string | undefined,
  count: number,
  ctx: SequenceBuildContext,
  percents?: readonly number[],
): string[] | undefined {
  if (ctx.seed === undefined || ctx.streamId === undefined) return undefined;
  if (values.length === 0 || count <= 0) return undefined;
  const shares =
    percents ??
    (percentAttr !== undefined && percentAttr.length > 0
      ? expandPercentMask(percentAttr, values.length)
      : values.map(() => 100 / values.length));

  const counts = computeCountsPerValue(
    count,
    shares,
    createPrng(`${ctx.seed}|${ctx.streamId}|pct`),
  );
  const key = permuteKey(ctx.seed, ctx.streamId);
  // Cumulative bounds: value v owns slots [cumHi[v-1], cumHi[v]).
  const cumHi: number[] = [];
  let acc = 0;
  for (const c of counts) {
    acc += c;
    cumHi.push(acc);
  }

  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const slot = permute(i, count, key);
    // Binary search rather than a linear scan: a wide column (many values)
    // would otherwise make the render O(count · values).
    let lo = 0;
    let hi = cumHi.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (slot < (cumHi[mid] ?? 0)) hi = mid;
      else lo = mid + 1;
    }
    out[i] = values[lo] ?? '';
  }
  return out;
}
