import { describe, expect, it } from 'vitest';

import {
  CANONICAL_LOCALES,
  CANONICAL_COUNTRIES,
  RTL_LOCALES,
  RESERVED_BUCKETS,
  directionOf,
  parseLocaleManifest,
  resolvePackAddress,
} from '../../src/data-pack/locales.js';

describe('canonical locales', () => {
  it('has 137 locales (135 moment files + en + zh)', () => {
    expect(CANONICAL_LOCALES.size).toBe(137);
  });

  it('includes the reference/populated locales and en', () => {
    for (const c of ['ru', 'es', 'en', 'he', 'ar', 'zh', 'zh-cn', 'en-gb']) {
      expect(CANONICAL_LOCALES.has(c), c).toBe(true);
    }
  });

  it('has 14 RTL locales, all inside the canonical set', () => {
    expect(RTL_LOCALES.size).toBe(14);
    for (const c of RTL_LOCALES) expect(CANONICAL_LOCALES.has(c), c).toBe(true);
  });

  it('directionOf reflects the RTL set', () => {
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('ar-sa')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('ru')).toBe('ltr');
  });

  it('reserves the common bucket', () => {
    expect(RESERVED_BUCKETS.has('common')).toBe(true);
  });

  it('resolves soft addresses against the locale, hard addresses as-is', () => {
    // Soft: no leading locale -> prepend the env locale.
    expect(resolvePackAddress('person.male.firstName', 'ru')).toBe('ru.person.male.firstName');
    expect(resolvePackAddress('person.male.firstName', 'en')).toBe('en.person.male.firstName');
    // Hard: leading known locale -> unchanged (env ignored).
    expect(resolvePackAddress('fr.person.male.firstName', 'ru')).toBe('fr.person.male.firstName');
    expect(resolvePackAddress('en.person.male.firstName', 'ru')).toBe('en.person.male.firstName');
    // Reserved bucket `common` is also hard (not a locale, but absolute).
    expect(resolvePackAddress('common.color.name', 'ru')).toBe('common.color.name');
    // Country names and `user` are hard (absolute) too.
    expect(resolvePackAddress('usa.tax.ssn', 'ru')).toBe('usa.tax.ssn');
    expect(resolvePackAddress('russia.vehicle.plate', 'en')).toBe('russia.vehicle.plate');
    expect(resolvePackAddress('user.test.thing', 'ru')).toBe('user.test.thing');
  });

  it('knows usa/russia as countries, distinct from language codes', () => {
    expect(CANONICAL_COUNTRIES.has('usa')).toBe(true);
    expect(CANONICAL_COUNTRIES.has('russia')).toBe(true);
    expect(CANONICAL_COUNTRIES.has('ru')).toBe(false); // `ru` is a language, not a country
    expect(RESERVED_BUCKETS.has('user')).toBe(true);
  });

  it('parses a manifest and falls back on bad input', () => {
    expect(parseLocaleManifest('{"code":"he","direction":"rtl"}', 'xx')).toEqual({
      code: 'he',
      direction: 'rtl',
    });
    // Bad JSON -> fall back to folder code + canonical direction.
    expect(parseLocaleManifest('not json', 'ar')).toEqual({ code: 'ar', direction: 'rtl' });
  });
});
