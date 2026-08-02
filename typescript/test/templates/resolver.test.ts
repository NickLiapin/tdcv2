import { describe, expect, it } from 'vitest';

import { createPrng } from '../../src/prng/prng.js';
// `person.b_day` and `date.range` are registered statically inside the resolver
// module, so importing the resolver alone must be enough to resolve them. All
// name/place DATA now lives in locale-first packs, not the resolver.
import { resolveTemplate } from '../../src/templates/resolver.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('resolveTemplate — builtin generators only', () => {
  it('returns undefined for unknown paths', () => {
    expect(resolveTemplate('nonsense.path')).toBeUndefined();
  });

  it.each(['person.b_day', 'date.range'])('resolves the builtin %s', (path) => {
    expect(resolveTemplate(path)).toBeDefined();
  });

  it.each(['person.male.firstName', 'person.lastName', 'person.gender', 'location.country'])(
    'does NOT resolve data path %s (moved to locale packs)',
    (path) => {
      expect(resolveTemplate(path)).toBeUndefined();
    },
  );

  it('person.b_day without explicit attrs uses default oldest/youngest/format', () => {
    const source = resolveTemplate('person.b_day');
    const value = source!(createPrng('bd'), {}, 'en', FIXED_NOW);
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it('person.b_day with explicit attrs produces a formatted date', () => {
    const source = resolveTemplate('person.b_day');
    const value = source!(
      createPrng('bd2'),
      { oldest: '70', youngest: '14', format: 'LL', local: 'en' },
      'en',
      FIXED_NOW,
    );
    // LL for English looks like "July 11, 2004"
    expect(value).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  });

  it('date.range with a valid range attribute produces a formatted date', () => {
    const source = resolveTemplate('date.range');
    const value = source!(
      createPrng('dr'),
      { range: '1900.01.01 - 2000.12.31', format: 'L', local: 'en' },
      'en',
      FIXED_NOW,
    );
    expect(value).toMatch(/\d+\/\d+\/\d+/);
  });

  it('date.range throws on invalid range', () => {
    const source = resolveTemplate('date.range');
    expect(() => source!(createPrng('err'), { range: 'not a range' }, 'en', FIXED_NOW)).toThrow(
      /range/,
    );
  });

  it('date.range throws on calendar-invalid range endpoints', () => {
    const source = resolveTemplate('date.range');
    expect(() =>
      source!(createPrng('err-calendar'), { range: '2024.02.30 - 2024.03.01' }, 'en', FIXED_NOW),
    ).toThrow(/range/);
  });
});
