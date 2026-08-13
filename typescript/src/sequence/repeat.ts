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
  /**
   * `lengths=`: the share of rows that get each possible length, `min` first.
   *
   * Without it every length is equally likely, and "equally" here is exact
   * rather than approximate — the lengths are laid out as a Hamilton quota, so
   * `repeat="0..5"` over 20,000 rows gives 16.66% to each of the six, with no
   * sampling noise at all. That is the wrong shape for every real one-to-many
   * relationship: orders per customer, visits per patient, transactions per
   * account are all heavy-tailed, most parents have one or two children and a
   * few have twenty.
   *
   * The shares go HERE, in the spec, rather than into a per-row draw, because a
   * per-row count would break the property this whole file exists to protect —
   * see the header. Deciding the lengths first, as a quota, keeps rows
   * independent AND makes the shape exact: `lengths="40,25,15,10,7,3"` means 40%
   * of parents have none, not "about 40%".
   */
  readonly lengths?: readonly number[] | undefined;
  /** Fewest values per row; may be 0 (empty list). */
  readonly min: number;
  /** Most values per row — also the per-row draw budget. */
  readonly max: number;
  readonly separator: string;
  /** `accumulate=`: the list is replaced by its running total before joining. */
  readonly accumulate?: AccumulateOp | undefined;
  /**
   * `distinct=`: the row's values are drawn WITHOUT replacement, so a cell
   * cannot hold the same value twice.
   *
   * This changes the regime the column is built in, which is the whole reason
   * `percent` is refused beside it. Ordinarily a listed column lays its values
   * out over the entire run as an exact quota; under `distinct` it draws per
   * row instead, because keeping an exact whole-run quota AND a per-row
   * guarantee at once costs either streaming or the randomness of the sample.
   * The trade is deliberate: frequencies stay approximate, rows stay
   * independent, and `--jobs` keeps working.
   */
  readonly distinct?: boolean | undefined;
}

/** Bounded retries before a `distinct` draw admits it cannot find a fresh value. */
export const DISTINCT_MAX_TRIES = 64;

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

  const lengths = parseLengths(attrs['lengths'], min, max);

  return {
    min,
    max,
    ...(lengths ? { lengths } : {}),
    separator: attrs['separator'] ?? DEFAULT_SEPARATOR,
    accumulate: readAccumulate(attrs),
    distinct: readDistinct(attrs),
  };
}

/**
 * `lengths="40,25,15,10,7,3"` — one share per possible length, `min` first.
 *
 * Refused rather than repaired when the count is wrong or the shares do not sum
 * to 100: a fan-out written with five shares for six lengths is a config whose
 * author had a shape in mind, and guessing which of the six they forgot would be
 * the sort of silent repair this project spends its time removing. The sum rule
 * is `percent=`'s, deliberately — one arithmetic for shares everywhere.
 */
export function parseLengths(
  raw: string | undefined,
  min: number,
  max: number,
): readonly number[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const groups = max - min + 1;
  if (parts.length !== groups) {
    throw new RepeatError(
      `lengths: ${String(parts.length)} share(s) for ${String(groups)} possible ` +
        `length(s) — repeat="${String(min)}..${String(max)}" can produce ${String(min)} ` +
        `to ${String(max)} values, so it needs one share for each`,
    );
  }
  const values = parts.map((p) => Number(p));
  for (const [i, v] of values.entries()) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RepeatError(`lengths: share for length ${String(min + i)} is not a number ≥ 0`);
    }
  }
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1e-9) {
    throw new RepeatError(`lengths: shares sum to ${String(sum)}, expected 100`);
  }
  return values;
}

/** `distinct="true"`. Anything other than the two words is refused by the validator. */
export function readDistinct(attrs: Record<string, string | undefined>): boolean {
  return (attrs['distinct'] ?? '').trim() === 'true';
}

/**
 * Draw `keep` DIFFERENT values from a weighted list, using one uniform per
 * attempt off the row's own stream.
 *
 * Weights survive — a frequent name is still more likely to be picked first —
 * but the exact whole-run quota does not, which is the documented price of
 * `distinct` and the reason `percent` may not appear beside it.
 *
 * The caller has already been told (by the validator) that the pool is big
 * enough, so running out here means a pool that only became known at run time.
 * That case throws rather than returning a short list: a list quietly shorter
 * than `repeat` asked for is exactly the silent-and-wrong outcome this whole
 * feature exists to prevent.
 */
export function drawDistinct(
  values: readonly string[],
  weights: readonly number[],
  keep: number,
  nextUniform: () => number,
  describePool: () => string,
): string[] {
  if (keep > values.length) {
    throw new RepeatError(
      `repeat with distinct="true" asks for ${String(keep)} different values, but ${describePool()} holds only ${String(values.length)}`,
    );
  }

  // Weighted draw without replacement: pick against the remaining weight, then
  // remove the winner. Swap-with-last keeps it linear per pick without
  // disturbing determinism, because the order of the remaining candidates is a
  // pure function of the picks already made.
  const pool = values.slice();
  const w =
    weights.length === values.length ? weights.slice() : new Array<number>(values.length).fill(1);
  let total = 0;
  for (const x of w) total += x > 0 ? x : 0;

  const out: string[] = [];
  for (let picked = 0; picked < keep; picked++) {
    const size = pool.length - picked;
    let index = size - 1;
    if (total > 0) {
      let target = nextUniform() * total;
      for (let i = 0; i < size; i++) {
        target -= Math.max(0, w[i] ?? 0);
        if (target < 0) {
          index = i;
          break;
        }
      }
    } else {
      index = Math.min(size - 1, Math.floor(nextUniform() * size));
    }
    out.push(pool[index] ?? '');
    total -= Math.max(0, w[index] ?? 0);
    const last = size - 1;
    pool[index] = pool[last] ?? '';
    w[index] = w[last] ?? 0;
    pool[last] = out[out.length - 1] ?? '';
  }
  return out;
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

/**
 * The shares `planRepeat` quotas by: `lengths=` when the config gave one, an
 * even split otherwise.
 *
 * Every caller — the in-memory builder, the keyed-draw layout and the streaming
 * builder — asks this one function, so a declared shape reaches all three
 * without any of them knowing it exists.
 */
export function repeatLengthPercents(spec: RepeatSpec): number[] {
  const groups = spec.max - spec.min + 1;
  if (spec.lengths) return [...spec.lengths];
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
