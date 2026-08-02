import { describe, expect, it } from 'vitest';

import {
  DateRuntimeError,
  formatDateTime,
  fromEpochMillis,
  parseDateRangeValue,
  parseDateTimeStrict,
  parseLegacyDateRange,
  subtractUtcYears,
  toEpochMillis,
  validateDateFormat,
} from '../../src/date/index.js';

describe('date runtime — parse and calendar', () => {
  it('parses strict dates and datetimes', () => {
    expect(parseDateTimeStrict('2024-02-29').value).toMatchObject({
      year: 2024,
      month: 2,
      day: 29,
      hour: 0,
    });
    expect(parseDateTimeStrict('2026-05-02T09:04:07.12').value).toMatchObject({
      year: 2026,
      month: 5,
      day: 2,
      hour: 9,
      minute: 4,
      second: 7,
      millisecond: 120,
    });
  });

  it('rejects calendar-invalid dates', () => {
    expect(() => parseDateTimeStrict('2023-02-29')).toThrow(DateRuntimeError);
    expect(() => parseDateTimeStrict('2024-13-01')).toThrow(DateRuntimeError);
    expect(() => parseDateTimeStrict('2024-01-01T24:00:00')).toThrow(DateRuntimeError);
  });

  it('parses new and legacy ranges strictly', () => {
    expect(parseDateRangeValue('2020-01-01..2025-12-31').start.value.year).toBe(2020);
    expect(parseLegacyDateRange('2020.01.01 - 2025.12.31').end.value.year).toBe(2025);
    expect(() => parseDateRangeValue('2020-01-01 - 2025-12-31')).toThrow(/START..END/);
    expect(() => parseLegacyDateRange('2020-01-01 - 2025-12-31')).toThrow(/date.range/);
  });

  it('subtracts UTC years with leap-day clamping', () => {
    const leapDayNoon = Date.UTC(2024, 1, 29, 12, 0, 0, 0);
    const shifted = fromEpochMillis(subtractUtcYears(leapDayNoon, 1));
    expect(shifted).toMatchObject({ year: 2023, month: 2, day: 28, hour: 12 });
  });

  it('round-trips through UTC epoch milliseconds', () => {
    const value = parseDateTimeStrict('2026-05-02T09:04:07.123').value;
    expect(fromEpochMillis(toEpochMillis(value))).toEqual(value);
  });

  it('preserves years below 100 instead of using JavaScript Date.UTC remapping', () => {
    const value = parseDateTimeStrict('0007-01-02T03:04:05.006').value;
    expect(fromEpochMillis(toEpochMillis(value))).toEqual(value);
  });
});

describe('date runtime — format', () => {
  const value = parseDateTimeStrict('2026-05-02T09:04:07.123').value;

  it('formats numeric and time tokens', () => {
    expect(formatDateTime(value, 'YYYY-MM-DD HH:mm:ss.SSS', 'en')).toBe('2026-05-02 09:04:07.123');
    expect(formatDateTime(value, 'YY/M/D H:m:s Z ZZ', 'en')).toBe('26/5/2 9:4:7 +00:00 +0000');
  });

  it('formats localized presets', () => {
    expect(formatDateTime(value, 'L', 'en')).toBe('05/02/2026');
    expect(formatDateTime(value, 'LL', 'en')).toBe('May 2, 2026');
    expect(formatDateTime(value, 'L', 'ru')).toBe('02.05.2026');
    expect(formatDateTime(value, 'LL', 'ru')).toBe('2 мая 2026 г.');
  });

  it('formats localized month and weekday names', () => {
    expect(formatDateTime(value, 'dddd, MMMM D', 'en')).toBe('Saturday, May 2');
    expect(formatDateTime(value, 'dddd, D MMMM', 'ru')).toBe('суббота, 2 мая');
  });

  it('formats zh-cn dates — Arabic digits in the standard form, Chinese-numeral months via MMMM', () => {
    // The standard L/LL forms keep Arabic digits, as modern China writes them.
    expect(formatDateTime(value, 'L', 'zh-cn')).toBe('2026/05/02');
    expect(formatDateTime(value, 'LL', 'zh-cn')).toBe('2026年5月2日');
    // MMMM is the authentic Chinese-numeral month name (五月 = "month five"),
    // and dddd the weekday (2026-05-02 is a Saturday → 星期六).
    expect(formatDateTime(value, 'YYYY[年]MMMMD[日] dddd', 'zh-cn')).toBe('2026年五月2日 星期六');
  });

  it('supports bracket literals and validates malformed literals', () => {
    expect(formatDateTime(value, '[date:] YYYY-MM-DD', 'en')).toBe('date: 2026-05-02');
    expect(() => {
      validateDateFormat('[unterminated');
    }).toThrow(DateRuntimeError);
  });
});
