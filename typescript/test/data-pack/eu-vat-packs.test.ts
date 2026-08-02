import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { luhnCheckDigit } from '../../src/presets/utils.js';

/**
 * Validity tests for the EU VAT / tax-id presets migrated from
 * `src/presets/countries/eu.ts` into bundled `.txt` pack generators.
 *
 * Each address is rendered through the normal bundled-pack path (no dataPaths)
 * and every value is checked against an INDEPENDENT reference re-derived here
 * from the country's standard (the same algorithm the old code implemented) —
 * the pack's own compute logic is never imported. The contract is validity
 * (correct format + checksum), not byte-for-byte equality with the old RNG.
 */

function render(address: string, count = 40, seed = 'eu-vat'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

/** Sum digit[i] * weights[i] over the string. */
function weighted(base: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (weights[i] ?? 0);
  return sum;
}

// --- Independent checksum references (re-derived from each standard) ---

function greekOk(s: string): boolean {
  if (!/^EL\d{9}$/.test(s)) return false;
  const base = s.slice(2, 10);
  const check = (weighted(base, [256, 128, 64, 32, 16, 8, 4, 2]) % 11) % 10;
  return Number(s[10]) === check;
}

function hungarianOk(s: string): boolean {
  if (!/^HU\d{8}$/.test(s)) return false;
  const base = s.slice(2, 9);
  const check = (10 - (weighted(base, [9, 7, 3, 1, 9, 7, 3]) % 10)) % 10;
  return Number(s[9]) === check;
}

function portugueseOk(s: string): boolean {
  if (!/^PT\d{9}$/.test(s)) return false;
  if (!'1235689'.includes(s[2] ?? '')) return false;
  const base = s.slice(2, 10);
  const raw = 11 - (weighted(base, [9, 8, 7, 6, 5, 4, 3, 2]) % 11);
  const check = raw >= 10 ? 0 : raw;
  return Number(s[10]) === check;
}

function belgianOk(s: string): boolean {
  if (!/^BE\d{10}$/.test(s)) return false;
  if (!'01'.includes(s[2] ?? '')) return false;
  const base = s.slice(2, 10);
  let check = 97 - (Number(base) % 97);
  if (check === 0) check = 97;
  return s.slice(10) === String(check).padStart(2, '0');
}

function croatianOk(s: string): boolean {
  if (!/^HR\d{11}$/.test(s)) return false;
  const base = s.slice(2, 12);
  let check = 10;
  for (const ch of base) {
    check = (Number(ch) + check) % 10;
    if (check === 0) check = 10;
    check = (check * 2) % 11;
  }
  return Number(s[12]) === (11 - check) % 10;
}

function swedishOk(s: string): boolean {
  if (!/^SE\d{12}$/.test(s)) return false;
  const base = s.slice(2, 11); // 9 digits
  const check = Number(s[11]);
  return luhnCheckDigit(base) === check && s.slice(12) === '01';
}

function finnishOk(s: string): boolean {
  if (!/^FI\d{8}$/.test(s)) return false;
  const base = s.slice(2, 9);
  const r = weighted(base, [7, 9, 10, 5, 8, 4, 2]) % 11;
  const check = r === 0 ? 0 : 11 - r;
  return check !== 10 && Number(s[9]) === check;
}

function slovenianOk(s: string): boolean {
  if (!/^SI\d{8}$/.test(s)) return false;
  const base = s.slice(2, 9);
  const raw = 11 - (weighted(base, [8, 7, 6, 5, 4, 3, 2]) % 11);
  const check = raw === 11 ? 0 : raw;
  return check !== 10 && Number(s[9]) === check;
}

describe('bundled EU VAT preset packs', () => {
  // --- plain (no checksum): format only ---
  const plain: readonly (readonly [string, RegExp])[] = [
    ['austria.tax.vat', /^ATU\d{8}$/],
    ['bulgaria.tax.vat', /^BG\d{9,10}$/],
    ['cyprus.tax.vat', /^CY\d{8}[A-Z]$/],
    ['czechia.tax.vat', /^CZ\d{8,10}$/],
    ['denmark.tax.vat', /^DK\d{8}$/],
    ['estonia.tax.vat', /^EE\d{9}$/],
    ['ireland.tax.vat', /^IE\d{7}[A-Z]$/],
    ['lithuania.tax.vat', /^LT(?:\d{9}|\d{12})$/],
    ['luxembourg.tax.vat', /^LU\d{8}$/],
    ['latvia.tax.vat', /^LV\d{11}$/],
    ['malta.tax.vat', /^MT\d{8}$/],
    ['romania.tax.vat', /^RO\d{2,10}$/],
    ['slovakia.tax.vat', /^SK\d{10}$/],
  ];
  for (const [address, pattern] of plain) {
    it(`${address} matches its format`, () => {
      const out = render(address);
      expect(out.length).toBe(40);
      for (const v of out) expect(v).toMatch(pattern);
    });
  }

  it('netherlands.tax.vat matches NL + 9 digits + B + 01-99', () => {
    for (const v of render('netherlands.tax.vat')) {
      expect(v).toMatch(/^NL\d{9}B\d{2}$/);
      const branch = Number(v.slice(-2));
      expect(branch).toBeGreaterThanOrEqual(1);
      expect(branch).toBeLessThanOrEqual(99);
    }
  });

  // --- checksum families ---
  const checksummed: readonly (readonly [string, (s: string) => boolean])[] = [
    ['belgium.tax.vat', belgianOk],
    ['greece.tax.vat', greekOk],
    ['hungary.tax.vat', hungarianOk],
    ['portugal.tax.vat', portugueseOk],
    ['croatia.tax.vat', croatianOk],
    ['sweden.tax.vat', swedishOk],
    ['finland.tax.vat', finnishOk],
    ['slovenia.tax.vat', slovenianOk],
  ];
  for (const [address, ok] of checksummed) {
    it(`${address} produces valid check digits`, () => {
      const out = render(address);
      expect(out.length).toBe(40);
      for (const v of out) expect(ok(v), `invalid value: ${v}`).toBe(true);
    });
  }

  it('is deterministic for a fixed seed', () => {
    expect(render('belgium.tax.vat', 20, 'x')).toEqual(render('belgium.tax.vat', 20, 'x'));
    expect(render('finland.tax.vat', 20, 'x')).toEqual(render('finland.tax.vat', 20, 'x'));
  });
});
