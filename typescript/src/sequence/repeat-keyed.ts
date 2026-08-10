/**
 * `repeat=` built in memory the way the streaming engine builds it.
 *
 * A repeating column has two plans, not one. How MANY values a row keeps is an
 * exact quota over the run — permuted by `#replen`, so a row's length follows
 * from its own position and never from a running total over its predecessors.
 * What those values ARE then depends on the generator: a list is laid out over
 * the whole slot space and read at the row's slots, while anything drawn takes
 * one seekable sub-stream per element, `#e0`, `#e1`, and so on.
 *
 * Both halves are keyed by `(seed, streamId)` and mirror `stream-build.ts`. The
 * older sequential builder in `repeat.ts` stays for the cases with nothing to
 * key by — an inline generator inside a pack body.
 */

import { computeCountsPerValue } from '../distribution/hamilton.js';
import { permute, permuteKey } from '../prng/permute.js';
import { createPrng } from '../prng/prng.js';
import { seekableGen, seekableUniforms } from '../prng/seekable.js';

import { buildGenValues } from './build.js';
import type { SequenceBuildContext } from './context.js';
import { absoluteRow } from './per-row.js';
import { redrawUntilFresh } from './repeat-distinct.js';
import {
  drawDistinct,
  joinParts,
  planRepeat,
  type RepeatSpec,
  repeatLengthPercents,
} from './repeat.js';
import type { GenSpec } from './types.js';

/** The same gen with `repeat` removed, so the per-element build cannot re-apply it. */
export function withoutRepeat(gen: GenSpec): GenSpec {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(gen.attrs)) if (k !== 'repeat') attrs[k] = v;
  return { ...gen, attrs };
}

/** How many values each position keeps, and where in the slot space they start. */
function lengthPlan(
  spec: RepeatSpec,
  count: number,
  seed: string,
  streamId: string,
): { positionAt: (i: number) => number; plan: ReturnType<typeof planRepeat> } {
  const counts = computeCountsPerValue(
    count,
    repeatLengthPercents(spec),
    createPrng(`${seed}|${streamId}|replen`),
  );
  const key = permuteKey(seed, `${streamId}#replen`);
  return { plan: planRepeat(spec, count, counts), positionAt: (i) => permute(i, count, key) };
}

/**
 * A repeating column of DRAWN values: element k of a row comes off the row's
 * own `#e{k}` stream, so the row still resolves alone.
 */
export function buildKeyedRepeatDraws(
  gen: GenSpec,
  spec: RepeatSpec,
  count: number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  seed: string,
  streamId: string,
  flagTextOut?: string[],
): string[] {
  const { plan, positionAt } = lengthPlan(spec, count, seed, streamId);
  const single = withoutRepeat(gen);
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const row = absoluteRow(ctx, i);
    const keep = plan.lengthAt(positionAt(i));
    const parts: string[] = [];
    const marks: string[] = [];
    for (let k = 0; k < keep; k++) {
      const flags: string[] | undefined = flagTextOut ? [] : undefined;
      // A drawn generator has no pool to draw down, so `distinct` is rejection
      // sampling on fresh sub-streams — the shared helper, so this engine and
      // the streaming one run the identical loop over identical stream ids.
      const drawAt = (suffix: string): string => {
        const draw = seekableGen(seed, `${streamId}#e${String(k)}${suffix}`, row);
        return buildGenValues(single, 1, draw, locale, now, ctx, flags)[0] ?? '';
      };
      const value = spec.distinct ? redrawUntilFresh(parts, gen.type, drawAt) : drawAt('');
      parts.push(value);
      if (flags) marks.push(flags[0] ?? 'false');
    }
    out[i] = joinParts(parts, spec);
    // A parallel list of true/false, never a running total — accumulating it
    // would mean nothing — so it joins with the separator alone.
    if (flagTextOut) flagTextOut[i] = marks.join(spec.separator);
  }
  return out;
}

/**
 * A repeating column of LISTED values: the slot space covers every element of
 * every row at once, laid out exactly and permuted, and a row reads the slots
 * its length plan gave it.
 */
export function buildKeyedRepeatLayout(
  spec: RepeatSpec,
  values: readonly string[],
  percents: readonly number[],
  count: number,
  ctx: SequenceBuildContext,
  seed: string,
  streamId: string,
  modify?: (row: number, value: string, k: number) => string,
): string[] {
  const { plan, positionAt } = lengthPlan(spec, count, seed, streamId);
  const slotCount = plan.totalSlots;
  const counts = computeCountsPerValue(slotCount, percents, createPrng(`${seed}|${streamId}|pct`));
  const key = permuteKey(seed, streamId);
  const cumHi: number[] = [];
  let acc = 0;
  for (const c of counts) {
    acc += c;
    cumHi.push(acc);
  }
  const valueForSlot = (slot: number): string => {
    let lo = 0;
    let hi = cumHi.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (slot < (cumHi[mid] ?? 0)) hi = mid;
      else lo = mid + 1;
    }
    return values[lo] ?? '';
  };

  // `distinct` leaves the whole-run layout behind: a row that must not repeat
  // itself has to CHOOSE from the pool, and a choice cannot be read off a
  // pre-laid-out slot. One uniform per pick, off the row's own stream, with the
  // budget fixed at the maximum length so the row still resolves alone.
  const distinctAt = spec.distinct
    ? keyedElementUniforms(seed, streamId, '#dist', spec.max)
    : undefined;

  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const p = positionAt(i);
    const row = absoluteRow(ctx, i);
    const start = plan.slotStartAt(p);
    const keep = plan.lengthAt(p);
    let parts: string[];
    if (distinctAt) {
      let k = 0;
      parts = drawDistinct(
        values,
        percents,
        keep,
        () => distinctAt(row, k++),
        () => 'the value list',
      );
      if (modify) parts = parts.map((raw, at) => modify(row, raw, at));
    } else {
      parts = [];
      for (let k = 0; k < keep; k++) {
        const raw = valueForSlot(permute(start + k, slotCount, key));
        parts.push(modify ? modify(row, raw, k) : raw);
      }
    }
    out[i] = joinParts(parts, spec);
  }
  return out;
}

/**
 * The `anomaly=`/`missing=`/`mask=` modifier for a repeating LISTED column.
 *
 * One draw per element, pulled a whole row at a time off the `#anom` and
 * `#miss` streams — the budget is the row's maximum length, so which uniform
 * element k gets does not depend on how long its row turned out to be.
 */
export function keyedElementUniforms(
  seed: string,
  streamId: string,
  purpose: string,
  budget: number,
): (row: number, k: number) => number {
  let cachedRow = -1;
  let draws: number[] = [];
  return (row, k) => {
    if (cachedRow !== row) {
      cachedRow = row;
      draws = seekableUniforms(seed, `${streamId}${purpose}`, row, budget);
    }
    return draws[k] ?? 1;
  };
}
