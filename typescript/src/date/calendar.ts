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
