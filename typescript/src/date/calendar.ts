/**
 * UTC Gregorian calendar helpers.
 */

import { DateRuntimeError, type PlainDateTime } from './types.js';

export const MS_PER_SECOND = 1000;
export const MS_PER_DAY = 86_400_000;

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

export function assertValidDateTime(value: PlainDateTime, source: string): void {
  if (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999) {
    throw new DateRuntimeError(`date: invalid year in "${source}"`);
  }
  if (!Number.isInteger(value.month) || value.month < 1 || value.month > 12) {
    throw new DateRuntimeError(`date: invalid month in "${source}"`);
  }
  const maxDay = daysInMonth(value.year, value.month);
  if (!Number.isInteger(value.day) || value.day < 1 || value.day > maxDay) {
    throw new DateRuntimeError(`date: invalid day in "${source}"`);
  }
  if (!Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23) {
    throw new DateRuntimeError(`date: invalid hour in "${source}"`);
  }
  if (!Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) {
    throw new DateRuntimeError(`date: invalid minute in "${source}"`);
  }
  if (!Number.isInteger(value.second) || value.second < 0 || value.second > 59) {
    throw new DateRuntimeError(`date: invalid second in "${source}"`);
  }
  if (!Number.isInteger(value.millisecond) || value.millisecond < 0 || value.millisecond > 999) {
    throw new DateRuntimeError(`date: invalid millisecond in "${source}"`);
  }
}

export function toEpochMillis(value: PlainDateTime): number {
  const normalized = new Date(
    Date.UTC(
      0,
      value.month - 1,
      value.day,
      value.hour,
      value.minute,
      value.second,
      value.millisecond,
    ),
  );
  normalized.setUTCFullYear(value.year);
  return normalized.getTime();
}

export function fromEpochMillis(ms: number): PlainDateTime {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millisecond: d.getUTCMilliseconds(),
  };
}

export function toEpochDay(value: PlainDateTime): number {
  return Math.floor(toEpochMillis(startOfDay(value)) / MS_PER_DAY);
}

export function fromEpochDay(day: number): PlainDateTime {
  return fromEpochMillis(day * MS_PER_DAY);
}

export function startOfDay(value: PlainDateTime): PlainDateTime {
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  };
}

export function subtractUtcYears(ms: number, years: number): number {
  const source = fromEpochMillis(ms);
  const year = source.year - years;
  const day = Math.min(source.day, daysInMonth(year, source.month));
  return toEpochMillis({ ...source, year, day });
}

export function utcWeekday(value: PlainDateTime): number {
  return new Date(toEpochMillis(value)).getUTCDay();
}

/**
 * A step is EITHER a fixed span or a calendar span, and never both.
 *
 * The distinction is not pedantry: `15m` is always 900 000 milliseconds, while
 * `1mo` is 28, 29, 30 or 31 days depending on where you start. They compose
 * within their own group — `1h30m`, `1y6mo` — and refuse to compose across it,
 * because "one month and fifteen days" depends on which you apply first, and a
 * config whose meaning turns on an invisible ordering is worse than one that
 * will not parse. Allowing the mix later is easy; changing what it already means
 * is not.
 */
export interface StepSpec {
  /** Milliseconds per step. Zero for a calendar step. */
  readonly ms: number;
  /** Months per step. Zero for a fixed step. */
  readonly months: number;
}

/** Fixed units. `m` is MINUTE, as it is everywhere this notation is used. */
const FIXED_UNIT_MS: Readonly<Record<string, number>> = {
  s: MS_PER_SECOND,
  m: 60 * MS_PER_SECOND,
  h: 3600 * MS_PER_SECOND,
  d: MS_PER_DAY,
  w: 7 * MS_PER_DAY,
};

/**
 * Calendar units, in months.
 *
 * `mo` rather than `m` because `m` is already the minute, and rather than `M`
 * because the difference between three minutes and three months would then rest
 * on the case of one letter — a distinction no reader checks and no tool that
 * normalizes case preserves.
 */
const CALENDAR_UNIT_MONTHS: Readonly<Record<string, number>> = { mo: 1, y: 12 };

/** What a `step=` may say, for a diagnostic to quote. */
export const STEP_SYNTAX = '15m, 1h30m, 2d, 3mo, 1y — units s, m, h, d, w, mo, y';

/** Why a `step=` did not parse, or the step it means. */
export type StepResult =
  | { readonly ok: true; readonly step: StepSpec }
  | { readonly ok: false; readonly reason: 'syntax' | 'mixed' };

/** The default step of a walked axis: one day. */
export const DEFAULT_STEP: StepSpec = { ms: MS_PER_DAY, months: 0 };

/**
 * `step="15m"`, `step="1h30m"`, `step="3mo"`, `step="2"` — how far a row advances.
 *
 * A bare number means DAYS, the default unit, so `step="2"` is every other day.
 * A unit may appear once: `1h30m1h` is a typo, and summing it would hide the
 * typo rather than report it.
 */
export function parseStep(raw: string | undefined): StepResult {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return { ok: true, step: DEFAULT_STEP };
  if (/^\d+$/.test(value)) {
    const days = Number(value);
    return days >= 1
      ? { ok: true, step: { ms: days * MS_PER_DAY, months: 0 } }
      : { ok: false, reason: 'syntax' };
  }
  if (!/^(?:\d+(?:mo|[smhdwy]))+$/.test(value)) return { ok: false, reason: 'syntax' };

  let ms = 0;
  let months = 0;
  const seen = new Set<string>();
  for (const [, digits, unit] of value.matchAll(/(\d+)(mo|[smhdwy])/g)) {
    const name = unit ?? '';
    if (seen.has(name)) return { ok: false, reason: 'syntax' };
    seen.add(name);
    const n = Number(digits);
    const fixed = FIXED_UNIT_MS[name];
    if (fixed === undefined) months += n * (CALENDAR_UNIT_MONTHS[name] ?? 0);
    else ms += n * fixed;
  }
  if (ms > 0 && months > 0) return { ok: false, reason: 'mixed' };
  if (ms === 0 && months === 0) return { ok: false, reason: 'syntax' };
  return { ok: true, step: { ms, months } };
}

/**
 * `start` advanced by `n` steps.
 *
 * A calendar month has no fixed length, so stepping by month or year keeps the
 * DAY OF MONTH and clamps it to the last day of a shorter one: 31 January plus
 * one month is 28 February, not 3 March. That is the same rule `subtractUtcYears`
 * above already applies to `person.b_day`, so the engine answers one way about
 * calendars rather than two.
 */
export function addStep(start: PlainDateTime, step: StepSpec, n: number): PlainDateTime {
  if (step.months === 0) return fromEpochMillis(toEpochMillis(start) + n * step.ms);
  const months = start.year * 12 + (start.month - 1) + n * step.months;
  const year = Math.floor(months / 12);
  const month = (((months % 12) + 12) % 12) + 1;
  return { ...start, year, month, day: Math.min(start.day, daysInMonth(year, month)) };
}

/**
 * How many steps fit in `start..end`, counting both ends.
 *
 * Computed rather than counted, because a second-by-second span of a century is
 * a number no loop should walk. A fixed step divides; a calendar one is estimated
 * from the month difference and corrected by at most one, which is what the
 * clamping in `addStep` can cost.
 */
export function stepsBetween(start: PlainDateTime, end: PlainDateTime, step: StepSpec): number {
  if (step.months === 0) {
    const span = toEpochMillis(end) - toEpochMillis(start);
    return span < 0 ? 1 : Math.floor(span / step.ms) + 1;
  }
  const months = (end.year - start.year) * 12 + (end.month - start.month);
  let n = Math.floor(months / step.months);
  if (n < 0) return 1;
  if (toEpochMillis(addStep(start, step, n)) > toEpochMillis(end)) n--;
  return n + 1;
}

/**
 * True when every row of this step lands on the same weekday.
 *
 * A calendar step does, and so does any whole number of weeks — `14d` as much as
 * `2w`, which the old unit-name test would have missed. A weekday filter over
 * such a step matches every row or none, so it is refused rather than silently
 * producing a full column or an empty one.
 */
export function fixesWeekday(step: StepSpec): boolean {
  return step.months > 0 || step.ms % (7 * MS_PER_DAY) === 0;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** What a `weekdays=` may say, for a diagnostic to quote. */
export const WEEKDAY_NAMES: readonly string[] = WEEKDAYS;

/**
 * `weekdays="mon..fri"` or `weekdays="sun,wed"` — which weekdays an axis keeps.
 *
 * `..` is the range operator everywhere else in the language, so it is the range
 * operator here. A SPAN wraps: `fri..mon` is Friday, Saturday, Sunday, Monday,
 * because a week is a circle and refusing to go round it would make half the
 * spans unwritable. Returns undefined on a name it does not know, so the caller
 * can say which.
 */
export function parseWeekdays(raw: string | undefined): ReadonlySet<number> | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return undefined;
  const keep = new Set<number>();
  for (const part of value.split(',')) {
    const span = part.trim();
    if (span === '') return undefined;
    const at = span.indexOf('..');
    if (at < 0) {
      const i = WEEKDAYS.indexOf(span as (typeof WEEKDAYS)[number]);
      if (i < 0) return undefined;
      keep.add(i);
      continue;
    }
    const from = WEEKDAYS.indexOf(span.slice(0, at).trim() as (typeof WEEKDAYS)[number]);
    const to = WEEKDAYS.indexOf(span.slice(at + 2).trim() as (typeof WEEKDAYS)[number]);
    if (from < 0 || to < 0) return undefined;
    for (let d = from; ; d = (d + 1) % 7) {
      keep.add(d);
      if (d === to) break;
    }
  }
  return keep;
}

/** The weekday of a date, 0 = Sunday, matching `parseWeekdays`. */
export function weekdayOf(value: PlainDateTime): number {
  return utcWeekday(value);
}

/* ── An offset from another date ──────────────────────────────────────────────
 *
 * `plus="3..10d"` — a discharge three to ten days after an admission, a delivery
 * one to three months after an order. The interval is the part of a real record
 * that could not be said at all: two independent date columns give a discharge
 * before its admission on a third of the rows, and non-overlapping windows
 * ("admitted in January, discharged April to June") throw away the very thing
 * the interval is for — its length and how that length is distributed.
 *
 * The notation is `count`, or `lo..hi`, followed by ONE unit — the same units
 * `step=` uses, so a reader who has written `step="3mo"` already knows this. The
 * unit sits at the end rather than on both sides because `3d..10d` invites two
 * DIFFERENT units, and "three days to two months" has no whole number of steps
 * to draw.
 */

/** A drawn offset: `lo..hi` steps of one unit. `lo === hi` is a fixed offset. */
export interface OffsetSpec {
  readonly lo: number;
  readonly hi: number;
  /** One step, as `addStep` takes it — so the calendar clamping is shared. */
  readonly unit: StepSpec;
}

/** What a `plus=` may say, for a diagnostic to quote. */
export const OFFSET_SYNTAX = '7d, 3..10d, 1..3mo, -5..-1d — units s, m, h, d, w, mo, y';

export type OffsetResult =
  | { readonly ok: true; readonly offset: OffsetSpec }
  | { readonly ok: false; readonly reason: 'syntax' | 'order' };

/**
 * `plus="3..10d"`, `plus="7d"`, `plus="-5..-1d"`, `plus="1..3mo"`.
 *
 * A bare number means DAYS, matching `step=`. The low bound may exceed neither
 * the high one nor the other way round — `10..3d` is a typo, and silently
 * swapping it would hide the typo rather than report it.
 */
export function parseOffset(raw: string | undefined): OffsetResult {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return { ok: false, reason: 'syntax' };

  const shape = /^(-?\d+)(?:\.\.(-?\d+))?(mo|[smhdwy])?$/.exec(value);
  if (!shape) return { ok: false, reason: 'syntax' };
  const [, loText, hiText, unitName] = shape;
  const lo = Number(loText);
  const hi = hiText === undefined ? lo : Number(hiText);
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi))
    return { ok: false, reason: 'syntax' };
  if (lo > hi) return { ok: false, reason: 'order' };

  const name = unitName ?? 'd';
  const fixed = FIXED_UNIT_MS[name];
  const months = CALENDAR_UNIT_MONTHS[name];
  const unit: StepSpec =
    fixed === undefined ? { ms: 0, months: months ?? 0 } : { ms: fixed, months: 0 };
  if (unit.ms === 0 && unit.months === 0) return { ok: false, reason: 'syntax' };
  return { ok: true, offset: { lo, hi, unit } };
}

/** The source date moved by `n` steps of the offset's unit. */
export function applyOffset(start: PlainDateTime, offset: OffsetSpec, n: number): PlainDateTime {
  return addStep(start, offset.unit, n);
}
