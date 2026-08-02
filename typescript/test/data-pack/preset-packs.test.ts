import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { luhnCheckDigit } from '../../src/presets/utils.js';

/**
 * Validity tests for former code presets now shipped as bundled `.tdc` pack
 * generators (migration spec, wave 1). Each renders the pack through the normal
 * bundled-pack path (no dataPaths) and checks the value against an INDEPENDENT
 * reference for that standard — the contract is validity, not byte-equality.
 */

function render(address: string, count = 40, seed = 'packs'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function luhnOk(digits: string): boolean {
  return luhnCheckDigit(digits.slice(0, -1)) === Number(digits.slice(-1));
}

function isbn10Ok(s: string): boolean {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return (s[9] === 'X' ? 10 : Number(s[9])) === c;
}

function germanVatOk(s: string): boolean {
  if (!/^DE\d{9}$/.test(s)) return false;
  const base = s.slice(2, 10);
  let product = 10;
  for (const ch of base) {
    let sum = (Number(ch) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = 11 - product === 10 ? 0 : 11 - product;
  return Number(s[10]) === check;
}

describe('bundled preset packs — wave 1', () => {
  it('common.book.isbn10 produces valid ISBN-10s', () => {
    const out = render('common.book.isbn10');
    expect(out.length).toBe(40);
    for (const v of out) expect(isbn10Ok(v)).toBe(true);
  });

  it('france.tax.siren produces valid Luhn SIRENs', () => {
    for (const v of render('france.tax.siren')) {
      expect(v).toMatch(/^\d{9}$/);
      expect(luhnOk(v)).toBe(true);
    }
  });

  it('italy.tax.vat produces valid IT VAT numbers', () => {
    for (const v of render('italy.tax.vat')) {
      expect(v).toMatch(/^IT\d{11}$/);
      expect(luhnOk(v.slice(2))).toBe(true);
    }
  });

  it('germany.tax.vat produces valid DE VAT numbers', () => {
    for (const v of render('germany.tax.vat')) {
      expect(v).toMatch(/^DE\d{9}$/);
      expect(germanVatOk(v)).toBe(true);
    }
  });

  it('is deterministic for a fixed seed', () => {
    expect(render('france.tax.siren', 20, 'x')).toEqual(render('france.tax.siren', 20, 'x'));
  });
});
