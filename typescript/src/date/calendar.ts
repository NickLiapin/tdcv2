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
 * The units a date sequence may be walked by.
 *
 * `week` is here and a step MULTIPLIER is not: "every seven days" is the case
 * people actually write, and a multiplier can be added later without changing
 * what any of these mean. `month` and `year` are calendar units rather than a
 * fixed span of milliseconds, which is why they are handled apart below.
 */
export const STEP_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;

export type StepUnit = (typeof STEP_UNITS)[number];

/** Milliseconds per step, for the units that have a fixed length. */
const FIXED_STEP_MS: Partial<Record<StepUnit, number>> = {
  second: MS_PER_SECOND,
  minute: 60 * MS_PER_SECOND,
  hour: 3600 * MS_PER_SECOND,
  day: MS_PER_DAY,
  week: 7 * MS_PER_DAY,
};

/**
 * `start` advanced by `n` steps.
 *
 * A calendar month has no fixed length, so stepping by month or year keeps the
 * DAY OF MONTH and clamps it to the last day of a shorter one: 31 January plus
 * one month is 28 February, not 3 March. That is the same rule `subtractUtcYears`
 * above already applies to `person.b_day`, so the engine answers one way about
 * calendars rather than two.
 */
export function addSteps(start: PlainDateTime, unit: StepUnit, n: number): PlainDateTime {
  const fixed = FIXED_STEP_MS[unit];
  if (fixed !== undefined) return fromEpochMillis(toEpochMillis(start) + n * fixed);
  const months = start.year * 12 + (start.month - 1) + (unit === 'year' ? n * 12 : n);
  const year = Math.floor(months / 12);
  const month = (((months % 12) + 12) % 12) + 1;
  return { ...start, year, month, day: Math.min(start.day, daysInMonth(year, month)) };
}

/**
 * How many steps of `unit` fit in `start..end`, counting both ends.
 *
 * Computed rather than counted, because a second-by-second span of a century is
 * a number no loop should walk. The fixed units divide; the calendar ones are
 * estimated from the month difference and corrected by at most one, which is
 * what the clamping in `addSteps` can cost.
 */
export function stepsBetween(start: PlainDateTime, end: PlainDateTime, unit: StepUnit): number {
  const fixed = FIXED_STEP_MS[unit];
  if (fixed !== undefined) {
    const span = toEpochMillis(end) - toEpochMillis(start);
    return span < 0 ? 1 : Math.floor(span / fixed) + 1;
  }
  const months = (end.year - start.year) * 12 + (end.month - start.month);
  let n = unit === 'year' ? end.year - start.year : months;
  if (n < 0) return 1;
  if (toEpochMillis(addSteps(start, unit, n)) > toEpochMillis(end)) n--;
  return n + 1;
}
