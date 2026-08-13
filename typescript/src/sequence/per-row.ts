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

import { advancedRegexHasWeightedChoice } from '../generators/advanced-regex.js';
import { resolvePackAddress } from '../data-pack/locales.js';
import { resolveExistingDataSourcePath } from '../data-source/index.js';
import { loadWeightedValues, weightColumnOf } from '../generators/weighted.js';
import type { PackEntry } from '../data-pack/load.js';

import type { SequenceBuildContext } from './context.js';
import { weightedTemplatePack } from './stream-weighted.js';
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

/**
 * The seed and column name this build draws under, when it has both.
 *
 * An inline generator or a nested build has no column of its own, so there is
 * nothing to key by and the caller falls back to the shared PRNG.
 */
export function keyedDraws(
  ctx: SequenceBuildContext,
): { seed: string; streamId: string } | undefined {
  if (ctx.seed === undefined || ctx.streamId === undefined) return undefined;
  return { seed: ctx.seed, streamId: ctx.streamId };
}

/**
 * The absolute row a drawn position belongs to.
 *
 * Index-dependent generators — counters, timeseries, a pattern stretched over
 * the run — read the POSITION for their value, and the streaming engine does
 * the same. Their random draws are keyed by the row instead, which is why the
 * two numbers have to be told apart.
 */
export function absoluteRow(ctx: SequenceBuildContext, position: number): number {
  return ctx.rows ? (ctx.rows[position] ?? position) : position;
}

/**
 * The context for a column whose drawn positions are known rows outright.
 *
 * A `<mix>` case is the reason this exists: its rows are not a contiguous run
 * and not a mask over the whole set either — they are whichever rows the
 * percentage layout gave that case.
 */
export function withRows(
  ctx: SequenceBuildContext,
  streamId: string,
  rows: readonly number[],
): SequenceBuildContext {
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
 * A generator is off this list when its column is a PLAN rather than a series
 * of draws — make one of those per-row and its proportions stop being exact.
 * `text` is the clearest case: even an UNWEIGHTED list is spread evenly over
 * the column and permuted, never picked independently per row, so
 * `exactTextLayout` below handles it instead of this path. The rest are
 * conditional and checked in `perRowBuildable`.
 */
const PER_ROW_TYPES: ReadonlySet<string> = new Set([
  'number',
  'regex',
  'symbol',
  'date',
  'template',
  'file',
  'advanced_regex',
]);

/** Can this generator be built row by row? `count <= 1` is already one row. */
export function perRowBuildable(
  gen: GenSpec,
  count: number,
  ctx: SequenceBuildContext,
  locale: string,
): boolean {
  if (count <= 1 || ctx.seed === undefined || ctx.streamId === undefined) return false;
  if (!PER_ROW_TYPES.has(gen.type)) return false;
  // `order="sequential"` reads the position, never the randomness.
  if (gen.attrs['order'] === 'sequential') return false;
  // A weighted file column and a pack that declares shares are both exact
  // quotas over the whole column: the streaming engine lays them out the way
  // it lays out weighted text, so this engine must too, not draw per row.
  if (gen.attrs['weight'] !== undefined) return false;
  // `sample="exact"` on a quantile read is a PLAN too: every row takes its own
  // point on the sorted sample, and which point follows from a scatter over the
  // whole column. Built a row at a time it would see a count of one and hand
  // every row the median — measured, before this line existed: the first
  // hundred thousand rows all came out 53.30.
  if ((gen.attrs['sample'] ?? '').trim() === 'exact') return false;
  if (weightedTemplatePack(gen, ctx.packs, gen.attrs['local'] ?? locale) !== undefined)
    return false;
  // A weighted choice inside an advanced_regex — `(?%{RU:70|US:20|DE:10})` —
  // is a quota over the whole column like any other share. Decided one row at
  // a time it awards every row to the largest share: 100% RU, not 70/20/10.
  if (gen.type === 'advanced_regex' && advancedRegexHasWeightedChoice(gen.attrs['value'] ?? '')) {
    return false;
  }
  // A pack GENERATOR may declare a share too. Its values are computed rather
  // than listed, so there is no list to lay out — the whole column is built at
  // once or the quota is wrong, and the streaming engine refuses it outright.
  if (packEntryFor(gen, ctx, locale)?.needsWholeColumn === true) return false;
  // `row=` links several columns to ONE row of a file. That choice belongs to
  // the row as a whole, not to any single column reading from it.
  if ((gen.attrs['row'] ?? '').trim() !== '') return false;
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
 * The context a REDRAW runs under: one row, no column name of its own.
 *
 * A `<distinct>` repair asks a generator for another value, and the streaming
 * engine asks with a context like this — so no whole-column layout can kick in
 * on a build of one row and hand back the same value it was trying to replace.
 * The caller supplies the stream through the PRNG it passes.
 */
export function redrawCtx(ctx: SequenceBuildContext): SequenceBuildContext {
  return { ...ctx, streamId: undefined, rows: undefined, layouts: undefined, perRow: true };
}

/**
 * Types the streaming engine builds INLINE — it reads the row's position rather
 * than deriving a value from the row — and whose `anomaly=`/`missing=` draws it
 * therefore takes from dedicated `#anom` and `#miss` streams instead of from
 * the generator's own. The in-memory engine has to key those two the same way.
 */
export const INLINE_ANOMALY_TYPES: ReadonlySet<string> = new Set([
  'text',
  'increment',
  'decrement',
  'timeseries',
  'pattern',
]);

/**
 * The value list and the shares a column lays out, when its values are LISTED
 * rather than drawn: a `text` list, a weighted file column, a weighted pack.
 *
 * These are the three the streaming engine sends down one path — it has no
 * separate uniform case, so an unweighted `text` list arrives here too, with
 * equal shares. Anything else returns undefined and is drawn per row.
 */
export function listedValues(
  gen: GenSpec,
  ctx: SequenceBuildContext,
  locale: string,
): { values: readonly string[]; percents: readonly number[] } | undefined {
  // `order="sequential"` reads the position, so there is no layout to speak of.
  if (gen.attrs['order'] === 'sequential') return undefined;
  const weightColumn = weightColumnOf(gen.attrs);
  if (weightColumn !== undefined) {
    // `row=` links whole rows of the file; the choice is not this column's.
    if ((gen.attrs['row'] ?? '').trim() !== '') return undefined;
    const path = resolveExistingDataSourcePath(gen.attrs['src'] ?? '', ctx.dataSources).path;
    return loadWeightedValues(
      path,
      {
        column: gen.attrs['column'],
        header: gen.attrs['header'],
        delimiter: gen.attrs['delimiter'],
      },
      weightColumn,
    );
  }
  const pack = weightedTemplatePack(gen, ctx.packs, gen.attrs['local'] ?? locale);
  if (pack) return pack;
  if (gen.type !== 'text') return undefined;
  const values = (gen.attrs['value'] ?? '').split(',').map((v) => v.trim());
  const percentAttr = gen.attrs['percent'];
  return {
    values,
    percents:
      percentAttr !== undefined && percentAttr.length > 0
        ? expandPercentMask(percentAttr, values.length)
        : values.map(() => 100 / values.length),
  };
}

/** The pack a `<gen type="template">` points at, if it points at one. */
function packEntryFor(
  gen: GenSpec,
  ctx: SequenceBuildContext,
  locale: string,
): PackEntry | undefined {
  if (gen.type !== 'template') return undefined;
  return ctx.packs?.get(resolvePackAddress(gen.attrs['value'] ?? '', gen.attrs['local'] ?? locale));
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
  const slotByRow = new Map<number, number>();
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
    slotByRow.set(absoluteRow(ctx, i), slot);
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
  // Remembered for any child that filters on this column: which slot a row got
  // is what decides its RANK inside the parent's subset, and the streaming
  // engine hands a child exactly that rank as its position.
  ctx.layouts?.set(ctx.streamId, { values, counts, cumHi, slotByRow });
  return out;
}

/**
 * What a column's exact layout gave each row — kept so a child can be ordered
 * the way the streaming engine orders it. See `orderedRows` in assemble.ts.
 */
export interface ExactLayout {
  readonly values: readonly string[];
  readonly counts: readonly number[];
  /** Cumulative upper bound per value: value v owns slots [cumHi[v-1], cumHi[v]). */
  readonly cumHi: readonly number[];
  readonly slotByRow: ReadonlyMap<number, number>;
}
