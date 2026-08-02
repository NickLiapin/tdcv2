import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Check-digit IDs for the French-speaking country packs, each re-derived here so
 * the pack and the test can't share a bug. Countries without a public check
 * digit are covered by the resolution/verify pass, not this file.
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

function ibanIsoOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  return mod97(expanded) === 1;
}

/** EAN-13 check digit over a 12-digit base (weights 1,3 from the left). */
function ean13Check(base12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

describe('belgium.docs.nationalRegister', () => {
  it('is 11 digits with a valid 97 - (base9 mod 97) check', () => {
    const out = render('belgium.docs.nationalRegister');
    expect(out).toHaveLength(60);
    for (const v of out) {
      expect(v).toMatch(/^\d{11}$/);
      expect(v.slice(9)).toBe(String(97 - mod97(v.slice(0, 9))).padStart(2, '0'));
    }
  });
});

describe('belgium.tax.enterpriseNumber', () => {
  it('is 10 digits (0/1 prefix) with a valid 97 - (base8 mod 97) check', () => {
    for (const v of render('belgium.tax.enterpriseNumber')) {
      expect(v).toMatch(/^[01]\d{9}$/);
      expect(v.slice(8)).toBe(String(97 - mod97(v.slice(0, 8))).padStart(2, '0'));
    }
  });
});

describe('belgium.finance.iban', () => {
  it('is BE + 14 digits with valid ISO and national check digits', () => {
    for (const v of render('belgium.finance.iban')) {
      expect(v).toMatch(/^BE\d{14}$/);
      expect(ibanIsoOk(v)).toBe(true);
      // National check: the 10-digit base mod 97, written as 97 when it is 0.
      const bban = v.slice(4);
      const base = bban.slice(0, 10);
      const nat = Number(bban.slice(10, 12));
      const rem = mod97(base);
      expect(nat).toBe(rem === 0 ? 97 : rem);
    }
  });
});

describe('switzerland.docs.avs', () => {
  it('is 756 + 9 digits with a valid EAN-13 check', () => {
    for (const v of render('switzerland.docs.avs')) {
      const digits = v.replace(/\D/g, '');
      expect(digits).toMatch(/^756\d{10}$/);
      expect(Number(digits[12])).toBe(ean13Check(digits.slice(0, 12)));
    }
  });
});

describe('switzerland.finance.iban', () => {
  it('is CH + 19 digits with a valid ISO check', () => {
    for (const v of render('switzerland.finance.iban')) {
      expect(v).toMatch(/^CH\d{19}$/);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('luxembourg.tax.vat', () => {
  it('is LU + 8 digits with a valid base6 mod 89 check', () => {
    for (const v of render('luxembourg.tax.vat')) {
      expect(v).toMatch(/^LU\d{8}$/);
      const base = v.slice(2, 8);
      expect(Number(v.slice(8))).toBe(Number(base) % 89);
    }
  });
});

describe('luxembourg.finance.iban', () => {
  it('is LU + 18 digits with a valid ISO check', () => {
    for (const v of render('luxembourg.finance.iban')) {
      expect(v).toMatch(/^LU\d{18}$/);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('monaco.finance.iban', () => {
  it('is MC + 25 chars with a valid ISO check and RIB key', () => {
    for (const v of render('monaco.finance.iban')) {
      expect(v).toMatch(/^MC\d{25}$/);
      expect(ibanIsoOk(v)).toBe(true);
      const bban = v.slice(4);
      const bank = Number(bban.slice(0, 5));
      const branch = Number(bban.slice(5, 10));
      const account = Number(bban.slice(10, 21));
      const key = Number(bban.slice(21, 23));
      expect((89 * bank + 15 * branch + 3 * account + key) % 97).toBe(0);
    }
  });
});

describe('belgium place data resolves', () => {
  it('renders Belgian cities, provinces and banks', () => {
    for (const addr of ['belgium.geo.city', 'belgium.geo.province', 'belgium.finance.bank']) {
      for (const v of render(addr, 8)) expect(v.length).toBeGreaterThan(1);
    }
  });
});

// African francophone countries and Haiti carry no public check digits, so they
// are covered by a resolution/format smoke test rather than the algorithm tests.
const SUB_SAHARAN = [
  'senegal',
  'ivory_coast',
  'mali',
  'burkina_faso',
  'benin',
  'togo',
  'niger',
  'guinea',
  'cameroon',
  'gabon',
  'congo',
  'dr_congo',
  'chad',
  'madagascar',
  'rwanda',
  'djibouti',
  'haiti',
];

describe('francophone country packs resolve', () => {
  it('render non-empty cities, banks and E.164 phones for each country', () => {
    for (const c of SUB_SAHARAN) {
      for (const v of render(`${c}.geo.city`, 6)) expect(v.length, c).toBeGreaterThan(1);
      for (const v of render(`${c}.finance.bank`, 6)) expect(v.length, c).toBeGreaterThan(1);
      for (const v of render(`${c}.phone`, 6)) expect(v, c).toMatch(/^\+\d{6,}$/);
    }
  });
});
