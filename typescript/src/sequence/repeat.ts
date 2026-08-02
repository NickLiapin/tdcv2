/**
 * `repeat="N"` / `repeat="A..B"` — emit SEVERAL values per row instead of one.
 *
 * The whole difficulty is determinism. Every engine here computes a row without
 * computing its predecessors (that is what makes streaming and `--jobs`
 * correct), which requires a FIXED number of PRNG draws per row. A variable
 * repeat count would break that.
 *
 * The answer is to decide the LENGTHS first, as an exact quota, before any
 * value exists. The total number of slots is then a known number, so nothing
 * is generated and thrown away — which is what keeps `<gen type="text">`
 * percentages exact even when the list length varies. Rows stay independent
 * because slots are grouped by length: a row finds its slice from its own
 * position, never from a running total over its predecessors.
 * Spec: docs/specs/2026-07-19-repeated-values-lists-and-mix-ground-truth.md §3.
 */

import { distributeByPercent } from '../distribution/hamilton.js';
import { accumulateParts, readAccumulate, type AccumulateOp } from './accumulate.js';

/** Upper bound on `repeat`, so a big value cannot silently make a run 1000× slower. */
export const MAX_REPEAT = 64;

/** Joins repeated values in text output when `separator` is not given. */
export const DEFAULT_SEPARATOR = ',';

export interface RepeatSpec {
  /** Fewest values per row; may be 0 (empty list). */
  readonly min: number;
  /** Most values per row — also the per-row draw budget. */
  readonly max: number;
  readonly separator: string;
  /** `accumulate=`: the list is replaced by its running total before joining. */
  readonly accumulate?: AccumulateOp | undefined;
}

export class RepeatError extends Error {
  public override readonly name = 'RepeatError';
}

/**
 * Generator types that cannot carry `repeat`, and why. Refused by the validator
 * so BOTH engines behave the same — the in-RAM builder could technically do
 * these, and letting it silently diverge from the default engine is the exact
 * "accepted and quietly ignored" trap TDC128 exists for.
 *
 * The reason is structural rather than unfinished work:
 *
 *   - **`increment` / `decrement` / `timeseries` / `pattern`** are positional:
 *     the value is a function of the row index. Under a VARIABLE repeat, the
 *     index an element should get depends on the total length of every earlier
 *     row — which is random. That makes the row un-computable on its own, and
 *     row independence is what streaming and `--jobs` are built on.
 */
export const REPEAT_UNSUPPORTED: Readonly<Record<string, string>> = {
  increment: 'its value depends on the row index, which a variable-length list makes unknowable',
  decrement: 'its value depends on the row index, which a variable-length list makes unknowable',
  timeseries: 'its value depends on the row index, which a variable-length list makes unknowable',
  pattern: 'its value depends on the row index, which a variable-length list makes unknowable',
};

/** Why `repeat` is refused on this generator type, or undefined when allowed. */
export function repeatUnsupportedReason(genType: string): string | undefined {
  return REPEAT_UNSUPPORTED[genType];
}

/**
 * Parse `repeat` / `separator`. Returns undefined when `repeat` is absent, in
 * which case the generator keeps its plain one-value-per-row behaviour.
 */
export function parseRepeat(attrs: Record<string, string | undefined>): RepeatSpec | undefined {
  const raw = attrs['repeat'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();

  const dots = text.indexOf('..');
  const [minText, maxText] =
    dots < 0 ? [text, text] : [text.slice(0, dots).trim(), text.slice(dots + 2).trim()];

  const min = Number(minText);
  const max = Number(maxText);
  for (const [label, value] of [
    ['minimum', min],
    ['maximum', max],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new RepeatError(`repeat: ${label} of "${raw}" must be a whole number`);
    }
  }
  if (min < 0) throw new RepeatError(`repeat: minimum of "${raw}" must not be negative`);
  if (max < min) throw new RepeatError(`repeat: "${raw}" has its maximum below its minimum`);
  if (max > MAX_REPEAT) {
    throw new RepeatError(`repeat: maximum of "${raw}" must not exceed ${String(MAX_REPEAT)}`);
  }

  return {
    min,
    max,
    separator: attrs['separator'] ?? DEFAULT_SEPARATOR,
    accumulate: readAccumulate(attrs),
  };
}

/**
 * How many values row `i` keeps, from one uniform in [0, 1). A fixed range maps
 * every draw to the same count — the draw is still spent, so the budget (and
 * therefore the row's independence) does not depend on the attribute's shape.
 */
export function repeatCountFrom(uniform: number, spec: RepeatSpec): number {
  const span = spec.max - spec.min + 1;
  const offset = Math.min(span - 1, Math.max(0, Math.floor(uniform * span)));
  return spec.min + offset;
}

/**
 * Lengths first, then filling — the plan that makes a VARIABLE repeat keep
 * exact percentages.
 *
 * The naive way gives every row `max` slots and throws away the ones past `N`.
 * The discarded slots already consumed quota, so the declared split stops
 * coming out exact. Deciding the lengths UP FRONT removes the waste entirely:
 * the total number of slots is then a known number, and the value quota is
 * planned over exactly that many.
 *
 * Row independence survives because slots are grouped BY LENGTH. All rows of
 * length L share one contiguous block, and the block sizes follow from the
 * length quota — which is computed once, before any row. So a row finds its
 * slots from its own position alone, never from a running total over its
 * predecessors (which would be the thing that breaks streaming and `--jobs`).
 * This is the same rank-within-a-subset trick `parent=` already uses.
 */
export interface RepeatPlan {
  readonly spec: RepeatSpec;
  /** Exact total number of value slots across all rows. */
  readonly totalSlots: number;
  /** How many values the row at permuted position `p` keeps. */
  lengthAt(p: number): number;
  /** First slot index owned by the row at permuted position `p`. */
  slotStartAt(p: number): number;
}

/**
 * Build the plan. `prng` is consumed only for the length quota's rounding, so
 * it must be a dedicated stream — never the one producing values.
 */
export function planRepeat(
  spec: RepeatSpec,
  rowCount: number,
  counts: readonly number[],
): RepeatPlan {
  const groups = spec.max - spec.min + 1;
  const rowCumLo: number[] = [];
  const slotOffset: number[] = [];
  let rowAcc = 0;
  let slotAcc = 0;
  for (let j = 0; j < groups; j++) {
    rowCumLo.push(rowAcc);
    slotOffset.push(slotAcc);
    const c = counts[j] ?? 0;
    rowAcc += c;
    slotAcc += c * (spec.min + j);
  }

  const groupOf = (p: number): number => {
    let lo = 0;
    let hi = groups - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p >= (rowCumLo[mid] ?? 0)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return {
    spec,
    totalSlots: slotAcc,
    lengthAt: (p) => spec.min + groupOf(p),
    slotStartAt: (p) => {
      const j = groupOf(p);
      const rank = p - (rowCumLo[j] ?? 0);
      return (slotOffset[j] ?? 0) + rank * (spec.min + j);
    },
  };
}

/** Even split across the possible lengths — the shares `planRepeat` quotas by. */
export function repeatLengthPercents(spec: RepeatSpec): number[] {
  const groups = spec.max - spec.min + 1;
  return new Array<number>(groups).fill(100 / groups);
}

/**
 * Take one row's slice out of a flat buffer holding `max` values per row, and
 * join it. `values` is laid out row-major: row i occupies `[i*max, (i+1)*max)`.
 */
export function joinRepeatRow(
  values: readonly string[],
  row: number,
  keep: number,
  spec: RepeatSpec,
): string {
  const start = row * spec.max;
  const out: string[] = [];
  for (let k = 0; k < keep; k++) out.push(values[start + k] ?? '');
  return joinParts(out, spec);
}

/**
 * The last step every repeat list goes through: accumulate, then join.
 *
 * One function rather than two copies because there are exactly two places a
 * list becomes a cell — here for the streaming engines and inside
 * {@link buildRepeatedValues} for the in-memory one — and a running total that
 * appeared on one engine and not the other is the failure this shape prevents.
 */
export function joinPartsOpt(
  parts: readonly string[] | undefined,
  spec: RepeatSpec,
): string | undefined {
  return parts === undefined ? undefined : joinParts(parts, spec);
}

export function joinParts(parts: readonly string[], spec: RepeatSpec): string {
  const running = spec.accumulate ? accumulateParts(parts, spec.accumulate) : parts;
  return running.join(spec.separator);
}

/**
 * Produce `count` rows of repeated values.
 *
 * `buildFlat` is the caller's ordinary "give me N values" builder — it already
 * applies `anomaly`/`missing`/formatting per value, which is precisely why
 * those modifiers come out per ELEMENT here with no extra work.
 *
 * The draw order is fixed and must not be rearranged: all `count` length draws
 * first, then the elements. Both engines rely on this being stable.
 *
 * `flagTextOut`, when given, receives the anomaly label per row — itself a list
 * parallel to the values, so it says WHICH element of a batch spiked rather
 * than merely that one did.
 */
export function buildRepeatedValues(
  spec: RepeatSpec,
  count: number,
  prng: () => number,
  buildFlat: (n: number, flagsOut?: boolean[]) => string[],
  flagTextOut?: string[],
): string[] {
  // Lengths first, as an exact quota — so the number of value slots is known
  // before a single value exists, and nothing has to be thrown away later.
  const groupCount = spec.max - spec.min + 1;
  const groupIds = Array.from({ length: groupCount }, (_, j) => j);
  const perRowGroup = distributeByPercent({
    count,
    values: groupIds,
    percents: repeatLengthPercents(spec),
    prng,
  });

  const counts = new Array<number>(groupCount).fill(0);
  for (const j of perRowGroup) counts[j] = (counts[j] ?? 0) + 1;
  const plan = planRepeat(spec, count, counts);

  // Rank within a length group gives the row its slice of that group's block.
  const nextRank = new Array<number>(groupCount).fill(0);
  const starts: number[] = new Array<number>(count);
  const keeps: number[] = new Array<number>(count);
  const offsets = groupOffsets(spec, counts);
  for (let i = 0; i < count; i++) {
    const j = perRowGroup[i] ?? 0;
    const length = spec.min + j;
    starts[i] = (offsets[j] ?? 0) + (nextRank[j] ?? 0) * length;
    nextRank[j] = (nextRank[j] ?? 0) + 1;
    keeps[i] = length;
  }

  const elementFlags: boolean[] | undefined = flagTextOut ? [] : undefined;
  const flat = buildFlat(plan.totalSlots, elementFlags);

  const out: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const start = starts[i] ?? 0;
    const keep = keeps[i] ?? 0;
    const parts: string[] = [];
    const marks: string[] = [];
    for (let k = 0; k < keep; k++) {
      parts.push(flat[start + k] ?? '');
      if (elementFlags) marks.push(elementFlags[start + k] === true ? 'true' : 'false');
    }
    out[i] = joinParts(parts, spec);
    if (flagTextOut) flagTextOut[i] = marks.join(spec.separator);
  }
  return out;
}

/** Slot-space offset where each length group's contiguous block begins. */
function groupOffsets(spec: RepeatSpec, counts: readonly number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let j = 0; j < counts.length; j++) {
    out.push(acc);
    acc += (counts[j] ?? 0) * (spec.min + j);
  }
  return out;
}

/**
 * The same generator with `repeat` removed. The streaming layer resolves each
 * element itself, so the per-row builder it delegates to must not repeat again.
 */
export function withoutRepeat(gen: { type: string; attrs: Record<string, string> }): {
  type: string;
  attrs: Record<string, string>;
} {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(gen.attrs)) {
    if (k !== 'repeat' && k !== 'accumulate') attrs[k] = v;
  }
  return { type: gen.type, attrs };
}
