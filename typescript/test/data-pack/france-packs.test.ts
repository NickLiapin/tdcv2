import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * France carries three independent check-digit schemes, each re-derived here so
 * the pack and the test can't share a bug:
 *   - NIR (sécurité sociale): 2-digit key = 97 - (13-digit body mod 97)
 *   - SIRET: the whole 14-digit number is Luhn-valid, and so is its SIREN
 *   - IBAN: ISO 7064 mod-97-10, plus the national RIB key (89·B + 15·G + 3·C + K ≡ 0)
 */

function render(address: string, count = 60, seed = 'fr'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="fr">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function mod97(digits: string): number {
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

function luhnValid(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

describe('france.docs.nir', () => {
  it('is 15 digits with a valid 97 - (body mod 97) control key', () => {
    const out = render('france.docs.nir');
    expect(out).toHaveLength(60);
    for (const v of out) {
      expect(v).toMatch(/^\d{15}$/);
      const key = 97 - mod97(v.slice(0, 13));
      expect(v.slice(13)).toBe(String(key).padStart(2, '0'));
    }
  });
});

describe('france.tax.siret', () => {
  it('is 14 digits, Luhn-valid as a whole and in its embedded SIREN', () => {
    const out = render('france.tax.siret');
    for (const v of out) {
      expect(v).toMatch(/^\d{14}$/);
      expect(luhnValid(v)).toBe(true);
      expect(luhnValid(v.slice(0, 9))).toBe(true);
    }
  });
});

describe('france.tax.siren', () => {
  it('is 9 digits and Luhn-valid', () => {
    for (const v of render('france.tax.siren')) {
      expect(v).toMatch(/^\d{9}$/);
      expect(luhnValid(v)).toBe(true);
    }
  });
});

describe('france.finance.iban', () => {
  it('is FR + 27 chars with a valid ISO check and a valid RIB key', () => {
    for (const v of render('france.finance.iban')) {
      expect(v).toMatch(/^FR\d{25}$/);
      expect(v).toHaveLength(27);
      // ISO 7064: rearranged number mod 97 must be 1.
      const rearranged = v.slice(4) + v.slice(0, 4);
      let expanded = '';
      for (const ch of rearranged) {
        expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      }
      expect(mod97(expanded)).toBe(1);
      // National RIB key: 89·bank + 15·branch + 3·account + key ≡ 0 (mod 97).
      const bban = v.slice(4);
      const bank = Number(bban.slice(0, 5));
      const branch = Number(bban.slice(5, 10));
      const account = Number(bban.slice(10, 21));
      const key = Number(bban.slice(21, 23));
      expect((89 * bank + 15 * branch + 3 * account + key) % 97).toBe(0);
    }
  });
});

describe('france.tax.vat', () => {
  it('is FR + 2-digit key + Luhn-valid SIREN, key = (12 + 3·(SIREN mod 97)) mod 97', () => {
    for (const v of render('france.tax.vat')) {
      expect(v).toMatch(/^FR\d{11}$/);
      const key = Number(v.slice(2, 4));
      const siren = v.slice(4);
      expect(luhnValid(siren)).toBe(true);
      expect(key).toBe((12 + 3 * (Number(siren) % 97)) % 97);
    }
  });
});

describe('france place and finance data resolves', () => {
  it('renders French cities, regions, departments and banks', () => {
    for (const addr of [
      'france.geo.city',
      'france.geo.region',
      'france.geo.department',
      'france.geo.streetName',
      'france.finance.bank',
    ]) {
      for (const v of render(addr, 8)) expect(v.length).toBeGreaterThan(1);
    }
  });

  it('is reproducible for a fixed seed', () => {
    expect(render('france.docs.nir', 20, 'x')).toEqual(render('france.docs.nir', 20, 'x'));
    expect(render('france.finance.iban', 20, 'x')).toEqual(render('france.finance.iban', 20, 'x'));
  });
});
