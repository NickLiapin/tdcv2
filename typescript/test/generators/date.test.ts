import { describe, expect, it } from 'vitest';

import { parseDateTimeStrict, toEpochMillis } from '../../src/date/index.js';
import { dateGenerator } from '../../src/generators/date.js';
import { createPrng } from '../../src/prng/prng.js';

const FIXED_NOW = Date.UTC(2026, 4, 2, 9, 4, 7, 123);

function generate(attrs: Parameters<typeof dateGenerator>[0], count = 25): readonly string[] {
  return dateGenerator(attrs, 'en', FIXED_NOW)(count, createPrng(`date:${JSON.stringify(attrs)}`));
}

describe('dateGenerator', () => {
  it('generates deterministic dates from an explicit range', () => {
    const attrs = { value: '2020-01-01..2020-01-31', format: 'YYYY-MM-DD' };
    const a = generate(attrs);
    const b = generate(attrs);
    expect(a).toEqual(b);
    for (const value of a) {
      expect(value).toMatch(/^2020-01-\d{2}$/);
      expect(value >= '2020-01-01').toBe(true);
      expect(value <= '2020-01-31').toBe(true);
    }
  });

  it('supports from/to datetime ranges with second precision', () => {
    const values = generate(
      {
        from: '2026-05-02T09:00:00',
        to: '2026-05-02T09:00:05',
        precision: 'second',
        format: 'YYYY-MM-DDTHH:mm:ss.SSS',
      },
      30,
    );
    expect(new Set(values).size).toBeGreaterThan(1);
    for (const value of values) {
      expect(value).toMatch(/^2026-05-02T09:00:0[0-5]\.000$/);
    }
  });

  it('supports birth-date mode with age bounds', () => {
    const values = generate({
      value: 'birth',
      oldest: '20',
      youngest: '18',
      format: 'YYYY-MM-DD',
    });
    const min = toEpochMillis(parseDateTimeStrict('2006-05-02').value);
    const max = toEpochMillis(parseDateTimeStrict('2008-05-02').value);
    for (const value of values) {
      const current = toEpochMillis(parseDateTimeStrict(value).value);
      expect(current).toBeGreaterThanOrEqual(min);
      expect(current).toBeLessThanOrEqual(max);
    }
  });

  it('supports fixed today and now values', () => {
    expect(generate({ value: 'today', format: 'YYYY-MM-DD' }, 3)).toEqual([
      '2026-05-02',
      '2026-05-02',
      '2026-05-02',
    ]);
    expect(generate({ value: 'now', format: 'YYYY-MM-DDTHH:mm:ss.SSS' }, 2)).toEqual([
      '2026-05-02T09:04:07.123',
      '2026-05-02T09:04:07.123',
    ]);
  });

  it('supports localized formatting', () => {
    const gen = dateGenerator({ value: '2026-05-02', format: 'LL', local: 'ru' }, 'en', FIXED_NOW);
    expect(gen(1, createPrng('ru-date'))).toEqual(['2 мая 2026 г.']);
  });

  it('rejects invalid ranges, ages, and precision', () => {
    expect(() => dateGenerator({ value: '2023-02-29' }, 'en', FIXED_NOW)).toThrow(/invalid day/);
    expect(() =>
      dateGenerator({ value: 'birth', oldest: '18', youngest: '20' }, 'en', FIXED_NOW),
    ).toThrow(/youngest/);
    expect(() => dateGenerator({ value: 'today', precision: 'week' }, 'en', FIXED_NOW)).toThrow(
      /precision/,
    );
  });
});
