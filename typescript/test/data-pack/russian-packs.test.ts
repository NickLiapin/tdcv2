import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Country packs for the post-Soviet states where Russian is official or used on
 * documents: Belarus, Kazakhstan, Kyrgyzstan, Tajikistan. They all draw values
 * from the existing `ru` locale pack. The verified check digits are the Belarus
 * and Kazakhstan IBANs (ISO 7064) and the Kazakhstani IIN (two-pass mod-11).
 */

function render(address: string, count = 40, seed = 'ru'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="ru">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function mod97(digits: string): number {
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

function ibanIsoOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  return mod97(expanded) === 1;
}

/** Kazakhstani IIN check digit: weighted mod-11 with a shifted-weight second pass. */
function iinCheck(base: string): number {
  const w1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
  const sum = (w: number[]): number => {
    let s = 0;
    for (let i = 0; i < base.length; i++) s += Number(base[i]) * w[i]!;
    return s;
  };
  const c1 = sum(w1) % 11;
  if (c1 < 10) return c1;
  const c2 = sum(w2) % 11;
  if (c2 < 10) return c2;
  return 0; // documented fallback: this prefix is never issued
}

describe('belarus.finance.iban', () => {
  it('is BY + 26 chars with a 4-letter bank code and a valid ISO 7064 check', () => {
    for (const v of render('belarus.finance.iban', 30)) {
      expect(v).toMatch(/^BY\d{2}[A-Z]{4}\d{20}$/);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('belarus.docs.personalNumber', () => {
  it('is 14 chars: century/sex + DDMMYY + region letter + serial + citizenship + control', () => {
    for (const v of render('belarus.docs.personalNumber', 30)) {
      expect(v).toMatch(/^[3-6]\d{6}[ABCEHKM]\d{4}[PBI][0-9A-Z]$/);
    }
  });
});

describe('kazakhstan.docs.iin', () => {
  it('is 12 digits and its two-pass mod-11 check digit re-derives', () => {
    for (const v of render('kazakhstan.docs.iin', 80)) {
      expect(v).toMatch(/^\d{12}$/);
      expect(Number(v[11])).toBe(iinCheck(v.slice(0, 11)));
      const month = Number(v.slice(2, 4));
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
    }
  });
});

describe('kazakhstan.finance.iban', () => {
  it('is KZ + 18 digits with a valid ISO 7064 check', () => {
    for (const v of render('kazakhstan.finance.iban', 30)) {
      expect(v).toMatch(/^KZ\d{18}$/);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('russian-speaking packs resolve', () => {
  const addresses = [
    'belarus.finance.bank',
    'belarus.geo.region',
    'belarus.geo.city',
    'belarus.phone',
    'belarus.vehicle.plate',
    'belarus.holiday',
    'belarus.sport.team',
    'belarus.education.university',
    'belarus.docs.unp',
    'kazakhstan.finance.bank',
    'kazakhstan.geo.region',
    'kazakhstan.geo.city',
    'kazakhstan.phone',
    'kazakhstan.vehicle.plate',
    'kazakhstan.holiday',
    'kazakhstan.sport.team',
    'kazakhstan.education.university',
    'kyrgyzstan.docs.inn',
    'kyrgyzstan.finance.account',
    'kyrgyzstan.finance.bank',
    'kyrgyzstan.geo.region',
    'kyrgyzstan.geo.city',
    'kyrgyzstan.phone',
    'kyrgyzstan.vehicle.plate',
    'kyrgyzstan.holiday',
    'kyrgyzstan.sport.team',
    'kyrgyzstan.education.university',
    'tajikistan.docs.inn',
    'tajikistan.finance.account',
    'tajikistan.finance.bank',
    'tajikistan.geo.region',
    'tajikistan.geo.city',
    'tajikistan.phone',
    'tajikistan.vehicle.plate',
    'tajikistan.holiday',
    'tajikistan.sport.team',
    'tajikistan.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('phone prefixes match the country calling code', () => {
  it.each([
    ['belarus.phone', /^\+375(25|29|33|44)\d{7}$/],
    ['kazakhstan.phone', /^\+77\d{9}$/],
    ['kyrgyzstan.phone', /^\+996\d{9}$/],
    ['tajikistan.phone', /^\+992\d{9}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 20)) expect(v).toMatch(re);
  });
});

describe('russian-speaking pack determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('kazakhstan.docs.iin', 20, 'x')).toEqual(render('kazakhstan.docs.iin', 20, 'x'));
  });
});
