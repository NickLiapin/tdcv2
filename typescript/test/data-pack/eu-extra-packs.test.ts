import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { luhnCheckDigit, weightedSum } from '../../src/presets/utils.js';

/** Validity tests for the EU dispatcher/attr VAT presets (france/europe/poland/spain). */

function render(address: string, count = 40, seed = 'eux'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function cifControl(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

describe('france.tax.vat', () => {
  it('is FR + mod-97 key + valid Luhn SIREN', () => {
    for (const v of render('france.tax.vat')) {
      expect(v).toMatch(/^FR\d{11}$/);
      const siren = v.slice(4);
      expect(luhnCheckDigit(siren.slice(0, 8))).toBe(Number(siren[8]));
      const key = (12 + 3 * (Number(siren) % 97)) % 97;
      expect(v.slice(2, 4)).toBe(String(key).padStart(2, '0'));
    }
  });
});

describe('europe.tax.vat', () => {
  it('delegates to a valid member-state VAT (DE)', () => {
    for (const v of render('europe.tax.vat')) {
      expect(v).toMatch(/^DE\d{9}$/);
    }
  });
});

describe('poland.tax.vat', () => {
  it('is PL + valid NIP (never rejected check==10)', () => {
    for (const v of render('poland.tax.vat')) {
      expect(v).toMatch(/^PL\d{10}$/);
      const base = v.slice(2, 11);
      const check = weightedSum(base, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
      expect(check).not.toBe(10);
      expect(check).toBe(Number(v[11]));
    }
  });
});

/**
 * A CIF control is the Luhn-style digit for entity letters A/B/E/H, the
 * letter "JABCDEFGHI"[digit] for N/P/Q/R/S/W, and either for the rest.
 */
function cifValid(cif: string): boolean {
  if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(cif)) return false;
  const entity = cif[0] ?? '';
  const digit = cifControl(cif.slice(1, 8));
  const letter = 'JABCDEFGHI'[digit];
  const control = cif[8];
  if ('NPQRSW'.includes(entity)) return control === letter;
  if ('ABEH'.includes(entity)) return control === String(digit);
  return control === String(digit) || control === letter;
}

describe('spain.tax.cif / vat', () => {
  it('has a valid control character for its entity letter', () => {
    for (const v of render('spain.tax.cif')) expect(cifValid(v), v).toBe(true);
  });

  it('emits both the digit-control and the letter-control entity families', () => {
    const kinds = new Set(render('spain.tax.cif', 200).map((v) => (/\d$/.test(v) ? 'd' : 'l')));
    expect(kinds).toEqual(new Set(['d', 'l']));
  });

  it('VAT is ES + a valid CIF', () => {
    for (const v of render('spain.tax.vat')) {
      expect(v).toMatch(/^ES/);
      expect(cifValid(v.slice(2)), v).toBe(true);
    }
  });
});
