/**
 * Number generator.
 *
 * Supported forms:
 *
 *   - `<gen type="number" value="MIN..MAX" .../>`
 *   - `<gen type="number" value="bit"/>`
 *   - `<gen type="number" value="[MIN..MAX],[MIN..MAX]" .../>`
 *   - `<gen type="number" length="N|MIN-MAX|A,B-C" [percent="..."]/>`
 *
 * Produces a uniform-random integer in [MIN, MAX] (inclusive at both
 * ends — mirrors the prototype semantics). Multi-range form first
 * picks one declared range uniformly, then picks uniformly inside that
 * range. Optional `length` pads numeric range output with leading zeros
 * to the given width.
 *
 * When `value` is omitted, the generator emits a digit string. Without
 * `length`, it emits one digit (0-9). With `length`, the result has the
 * selected number of digits. This mode is intentionally string-based,
 * so lengths far beyond JavaScript's safe integer range are fine.
 *
 * This is the primary numeric generator used outside sequences —
 * inside sequences it goes through the shared dispatch in
 * src/sequence/build.ts.
 */

import { distributeByPercent, expandPercentMask } from '../distribution/index.js';
import { randomInt } from '../prng/random.js';

import type { Generator } from './generator.js';

export interface NumberGenAttrs {
  readonly range?: string | undefined; // "bit", "MIN..MAX" or "[MIN..MAX],[MIN..MAX]"
  readonly length?: number | string | undefined; // width, width range, or width groups
  readonly percent?: string | undefined; // exact distribution across length groups
  readonly firstZero?: boolean | undefined; // allow leading zero; default true
  readonly include?: string | undefined; // integer values/ranges to ADD, e.g. "100" or "5,40..60"
  readonly exclude?: string | undefined; // integer values/ranges to REMOVE, e.g. "3" or "40..60"
  readonly decimals?: number | string | undefined; // digits after the point; 0 = integers
}

export interface NumberRange {
  readonly min: number;
  readonly max: number;
  readonly width?: number;
}

interface Interval {
  min: number;
  max: number;
}

/**
 * Parse an include/exclude list: comma-separated tokens, each a single
 * integer (`3`) or an inclusive range (`40..60`). Used to add/remove
 * integer values from a numeric range.
 */
export function parseNumberIntervalList(source: string, label: string): Interval[] {
  const spec = source.trim();
  if (spec.length === 0) throw new Error(`number generator: ${label} is empty`);
  return spec.split(',').map((raw) => {
    const part = raw.trim();
    if (/^-?\d+$/.test(part)) {
      const n = Number(part);
      return { min: n, max: n };
    }
    const m = /^(-?\d+)\s*\.\.\s*(-?\d+)$/.exec(part);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a > b) throw new Error(`number generator: ${label} range "${part}" is reversed`);
      return { min: a, max: b };
    }
    throw new Error(`number generator: invalid ${label} "${source}"`);
  });
}

/** Merge overlapping/adjacent intervals into a sorted disjoint set. */
function normalizeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.min - b.min || a.max - b.max);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.min <= last.max + 1) {
      last.max = Math.max(last.max, iv.max);
    } else {
      merged.push({ min: iv.min, max: iv.max });
    }
  }
  return merged;
}

/** Subtract a set of intervals from a disjoint interval set. */
function subtractRanges(ranges: readonly Interval[], excludes: readonly Interval[]): Interval[] {
  let result = ranges.map((r) => ({ min: r.min, max: r.max }));
  for (const ex of excludes) {
    const next: Interval[] = [];
    for (const r of result) {
      if (ex.max < r.min || ex.min > r.max) {
        next.push(r);
        continue;
      }
      if (ex.min > r.min) next.push({ min: r.min, max: ex.min - 1 });
      if (ex.max < r.max) next.push({ min: ex.max + 1, max: r.max });
    }
    result = next;
  }
  return result;
}

/**
 * Compute the allowed integer intervals for `(base ∪ include) − exclude`.
 * Returns disjoint, size-weighted-selectable intervals, or throws when the
 * result is empty. Pure interval math — never enumerates values, so it is
 * efficient even for astronomically large ranges.
 */
export function computeAllowedIntervals(
  base: readonly NumberRange[],
  include: string | undefined,
  exclude: string | undefined,
): Interval[] {
  let combined: Interval[] = base.map((r) => ({ min: r.min, max: r.max }));
  if (include !== undefined && include.trim().length > 0) {
    combined = combined.concat(parseNumberIntervalList(include, 'include'));
  }
  combined = normalizeIntervals(combined);
  if (exclude !== undefined && exclude.trim().length > 0) {
    combined = subtractRanges(combined, parseNumberIntervalList(exclude, 'exclude'));
  }
  if (combined.length === 0) {
    throw new Error('number generator: the range is empty after include/exclude');
  }
  return combined;
}

export interface NumberLengthChoice {
  readonly min: number;
  readonly max: number;
}

export function parseNumberRanges(source: string): readonly NumberRange[] {
  const spec = source.trim();
  if (spec.length === 0) {
    throw new Error('number generator: range is empty');
  }
  if (spec === 'bit') {
    return [{ min: 0, max: 1 }];
  }
  if (!spec.includes('[') && !spec.includes(']')) {
    return [parseRange(spec)];
  }

  const ranges: NumberRange[] = [];
  let rest = spec;
  while (rest.length > 0) {
    // Found by index, not by a regex. `/^\[\s*([^\]]+?)\s*\]/` said the same
    // thing, but `\s*` and `[^\]]+?` can both match a space, so an unclosed
    // bracket made the engine try every way to split the run between them:
    // `value="[` followed by ten thousand spaces did not finish in five
    // minutes. A generator hanging on its own config is not a slow path, it is
    // a stopped program.
    const close = rest.startsWith('[') ? rest.indexOf(']') : -1;
    if (close < 0) {
      throw new Error(`number generator: invalid range list "${source}"`);
    }
    ranges.push(parseRange(rest.slice(1, close).trim()));
    rest = rest.slice(close + 1).trim();
    if (rest.length === 0) break;
    if (!rest.startsWith(',')) {
      throw new Error(`number generator: invalid range list "${source}"`);
    }
    rest = rest.slice(1).trim();
    if (rest.length === 0) {
      throw new Error(`number generator: invalid range list "${source}"`);
    }
  }
  return ranges;
}

export function parseNumberLengthChoices(source: string | number): readonly NumberLengthChoice[] {
  if (typeof source === 'number') return [toLengthChoice(source, source, String(source))];

  const spec = source.trim();
  if (spec.length === 0) {
    throw new Error('number generator: length is empty');
  }
  return spec.split(',').map((raw) => {
    const part = raw.trim();
    const fixed = /^\d+$/.exec(part);
    if (fixed) return toLengthChoice(Number(part), Number(part), source);

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) return toLengthChoice(Number(range[1]), Number(range[2]), source);

    throw new Error(`number generator: invalid length "${source}"`);
  });
}

function parseRange(range: string): NumberRange {
  const m = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(range);
  if (!m) {
    throw new Error(`number generator: invalid range "${range}" (expected MIN..MAX)`);
  }
  return toRange(m[1] ?? '', m[2] ?? '', range);
}

function toRange(minText: string, maxText: string, source: string): NumberRange {
  const min = Number(minText);
  const max = Number(maxText);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error(`number generator: invalid numeric range "${source}"`);
  }
  const width = inferRangeWidth(minText, maxText);
  return width === undefined ? { min, max } : { min, max, width };
}

function toLengthChoice(min: number, max: number, source: string): NumberLengthChoice {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min <= 0 || max <= 0 || min > max) {
    throw new Error(`number generator: invalid length "${source}"`);
  }
  return { min, max };
}

function inferRangeWidth(minText: string, maxText: string): number | undefined {
  if (minText.startsWith('-') || maxText.startsWith('-')) return undefined;
  const hasLeadingZeros =
    (minText.length > 1 && minText.startsWith('0')) ||
    (maxText.length > 1 && maxText.startsWith('0'));
  return hasLeadingZeros ? Math.max(minText.length, maxText.length) : undefined;
}

/**
 * Digits after the decimal point. Absent or 0 means integers, which is what
 * every existing config gets.
 */
export function parseNumberDecimals(raw: number | string | undefined): number {
  if (raw === undefined) return 0;
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < 0 || value > 10) {
    throw new Error(`number decimals must be an integer 0..10, got "${String(raw)}"`);
  }
  return value;
}

/**
 * A uniform draw over the DECIMAL grid of a range.
 *
 * Scaling the bounds by 10^decimals and drawing one integer keeps the draw
 * uniform over every representable value and costs exactly one PRNG call — the
 * same budget an integer draw has, so nothing about seekability changes.
 * Drawing the whole part and a fraction separately would double the budget and
 * bias the endpoints.
 */
function randomDecimalFromRanges(
  ranges: readonly NumberRange[],
  decimals: number,
  prng: () => number,
): string {
  const scale = Math.pow(10, decimals);
  const spans = ranges.map((r) => {
    const lo = Math.round(r.min * scale);
    const hi = Math.round(r.max * scale);
    return { lo, size: hi - lo + 1 };
  });
  const total = spans.reduce((sum, s) => sum + s.size, 0);
  let pick = Math.floor(prng() * total);
  for (const span of spans) {
    if (pick < span.size) return ((span.lo + pick) / scale).toFixed(decimals);
    pick -= span.size;
  }
  const last = spans[spans.length - 1] ?? { lo: 0, size: 1 };
  return ((last.lo + last.size - 1) / scale).toFixed(decimals);
}

export function numberGenerator(attrs: NumberGenAttrs): Generator {
  const rangeSpec = attrs.range?.trim();
  const ranges = rangeSpec ? parseNumberRanges(rangeSpec) : [];
  const hasExplicitLength = attrs.length !== undefined;
  const lengthChoices =
    attrs.length !== undefined
      ? parseNumberLengthChoices(attrs.length)
      : ranges.length === 0
        ? [{ min: 1, max: 1 }]
        : [];
  const allowLeadingZero = attrs.firstZero ?? (ranges.length > 0 || !hasExplicitLength);

  if (attrs.percent !== undefined && lengthChoices.length <= 1) {
    expandPercentMask(attrs.percent, lengthChoices.length);
  }

  // include/exclude: compute the allowed integer intervals once, then draw
  // uniformly over ALL remaining values (size-weighted across intervals).
  const hasModifiers =
    (attrs.include !== undefined && attrs.include.trim().length > 0) ||
    (attrs.exclude !== undefined && attrs.exclude.trim().length > 0);
  let allowed: Interval[] | undefined;
  let allowedWidth = 0;
  if (hasModifiers) {
    if (ranges.length === 0) {
      throw new Error(
        'number generator: include/exclude require a numeric range in "value", e.g. value="0..9"',
      );
    }
    allowed = computeAllowedIntervals(ranges, attrs.include, attrs.exclude);
    allowedWidth = ranges.find((r) => r.width !== undefined)?.width ?? 0;
  }

  const decimals = parseNumberDecimals(attrs.decimals);
  // A fractional draw is uniform over the decimal grid of the declared range;
  // width and leading-zero rules are integer notions and do not apply.
  if (decimals > 0 && ranges.length > 0 && allowed === undefined) {
    return (count, prng) => {
      const out: string[] = new Array<string>(count);
      for (let i = 0; i < count; i++) out[i] = randomDecimalFromRanges(ranges, decimals, prng);
      return out;
    };
  }

  return (count, prng) => {
    const out: string[] = new Array<string>(count);
    const widths = materializeWidths(count, lengthChoices, attrs.percent, prng);
    for (let i = 0; i < count; i++) {
      const width = widths[i] ?? 0;
      if (allowed !== undefined) {
        out[i] = randomFromWeightedIntervals(
          allowed,
          width > 0 ? width : allowedWidth,
          allowLeadingZero,
          prng,
        );
      } else if (ranges.length === 0) {
        out[i] = randomDigitString(width, allowLeadingZero, prng);
      } else {
        out[i] = randomFromRanges(ranges, width, allowLeadingZero, prng);
      }
    }
    return out;
  };
}

/**
 * Draw uniformly over all values in a disjoint interval set: pick a value
 * index in [0, totalSize), map it to the interval that contains it. This
 * makes `value="0..9" exclude="3"` uniform over the 9 remaining values.
 */
function randomFromWeightedIntervals(
  intervals: readonly Interval[],
  width: number,
  allowLeadingZero: boolean,
  prng: () => number,
): string {
  let s = drawWeighted(intervals, width, prng);
  if (!allowLeadingZero && s.startsWith('0')) {
    let guard = 0;
    while (s.startsWith('0') && guard < 100) {
      s = drawWeighted(intervals, width, prng);
      guard += 1;
    }
  }
  return s;
}

function drawWeighted(intervals: readonly Interval[], width: number, prng: () => number): string {
  let total = 0;
  for (const iv of intervals) total += iv.max - iv.min + 1;
  let k = randomInt(prng, 0, total);
  let n = intervals[0]?.min ?? 0;
  for (const iv of intervals) {
    const size = iv.max - iv.min + 1;
    if (k < size) {
      n = iv.min + k;
      break;
    }
    k -= size;
  }
  const s = String(n);
  return width > 0 ? s.padStart(width, '0') : s;
}

function materializeWidths(
  count: number,
  choices: readonly NumberLengthChoice[],
  percent: string | undefined,
  prng: () => number,
): number[] {
  if (choices.length === 0) return new Array<number>(count).fill(0);

  const selected =
    percent === undefined
      ? randomLengthChoices(count, choices, prng)
      : distributeByPercent({
          count,
          values: choices,
          percents: expandPercentMask(percent, choices.length),
          prng,
        });

  return selected.map((choice) =>
    choice.min === choice.max ? choice.min : randomInt(prng, choice.min, choice.max + 1),
  );
}

function randomLengthChoices(
  count: number,
  choices: readonly NumberLengthChoice[],
  prng: () => number,
): NumberLengthChoice[] {
  const first = choices[0];
  if (!first) return [];
  if (choices.length === 1) return new Array<NumberLengthChoice>(count).fill(first);
  const out: NumberLengthChoice[] = new Array<NumberLengthChoice>(count);
  for (let i = 0; i < count; i++) {
    out[i] = choices[randomInt(prng, 0, choices.length)] ?? first;
  }
  return out;
}

function randomFromRanges(
  ranges: readonly NumberRange[],
  width: number,
  allowLeadingZero: boolean,
  prng: () => number,
): string {
  let s = drawRangeValue(ranges, width, prng);
  if (!allowLeadingZero && s.startsWith('0')) {
    let guard = 0;
    while (s.startsWith('0') && guard < 100) {
      s = drawRangeValue(ranges, width, prng);
      guard += 1;
    }
  }
  return s;
}

function drawRangeValue(ranges: readonly NumberRange[], width: number, prng: () => number): string {
  const range = ranges.length === 1 ? ranges[0] : ranges[randomInt(prng, 0, ranges.length)];
  if (!range) return '';
  // randomInt is half-open; +1 makes it [min, max] inclusive.
  const n = randomInt(prng, range.min, range.max + 1);
  const s = String(n);
  const actualWidth = width > 0 ? width : (range.width ?? 0);
  return actualWidth > 0 ? s.padStart(actualWidth, '0') : s;
}

function randomDigitString(width: number, allowLeadingZero: boolean, prng: () => number): string {
  let out = '';
  for (let i = 0; i < width; i++) {
    const min = i === 0 && !allowLeadingZero ? 1 : 0;
    out += String(randomInt(prng, min, 10));
  }
  return out;
}
