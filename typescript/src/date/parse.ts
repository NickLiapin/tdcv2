/**
 * Strict date/datetime parsing for the TDC date generator.
 */

import { assertValidDateTime } from './calendar.js';
import { DateRuntimeError, type PlainDateTime } from './types.js';

export interface ParsedDateTime {
  readonly value: PlainDateTime;
  readonly hasTime: boolean;
}

export interface ParsedDateRange {
  readonly start: ParsedDateTime;
  readonly end: ParsedDateTime;
}

const DATE_TIME_RE =
  /^(\d{4})([./-])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

export function parseDateTimeStrict(source: string): ParsedDateTime {
  const raw = source.trim();
  const match = DATE_TIME_RE.exec(raw);
  if (!match) {
    throw new DateRuntimeError(
      `date: invalid date "${source}" (expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)`,
    );
  }
  const hasTime = match[5] !== undefined;
  const value: PlainDateTime = {
    year: Number(match[1]),
    month: Number(match[3]),
    day: Number(match[4]),
    hour: hasTime ? Number(match[5]) : 0,
    minute: hasTime ? Number(match[6]) : 0,
    second: match[7] === undefined ? 0 : Number(match[7]),
    millisecond: match[8] === undefined ? 0 : Number(match[8].padEnd(3, '0')),
  };
  assertValidDateTime(value, source);
  return { value, hasTime };
}

export function parseDateRangeValue(source: string): ParsedDateRange {
  const parts = source.split('..');
  if (parts.length !== 2) {
    throw new DateRuntimeError(`date: invalid range "${source}" (expected START..END)`);
  }
  return {
    start: parseDateTimeStrict(parts[0] ?? ''),
    end: parseDateTimeStrict(parts[1] ?? ''),
  };
}

export function parseLegacyDateRange(source: string): ParsedDateRange {
  const pattern = /^(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})$/;
  const match = pattern.exec(source.trim());
  if (!match) {
    throw new DateRuntimeError(`date.range: invalid range attribute "${source}"`);
  }
  return {
    start: parseDateTimeStrict(match[1] ?? ''),
    end: parseDateTimeStrict(match[2] ?? ''),
  };
}
