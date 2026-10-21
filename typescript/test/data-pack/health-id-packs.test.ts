import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Health identifiers — the US NPI, Germany's KVNR and LANR, France's RPPS and FINESS, Brazil's
 * CNS — and the North American phone numbers built on real area codes.
 *
 * Each validator below is written from the published rule, not from the pack, and is first held
 * against numbers taken from the rule's own source: the CMS worked example and real NPPES records,
 * the KVNR guideline example, the KBV pseudo LANRs, the ANS examples, a real hospital's FINESS,
 * ANVISA's CNS examples. A validator that passes those and fails their one-digit neighbours is a
 * validator that can catch a broken pack.
 */

const here = dirname(fileURLToPath(import.meta.url));
const countries = resolve(here, '../../../data/packs/countries');

function render(genTag: string, count = 400, seed = 'health'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P">${genTag}</sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

const pack = (address: string, count?: number): string[] =>
  render(`<gen type="template" value="${address}"/>`, count);

function digits(s: string): number[] {
  return Array.from({ length: s.length }, (_, i) => Number(s[i]));
}

/** Luhn over the whole string, check digit included. */
function luhnValid(s: string): boolean {
  let sum = 0;
  digits(s)
    .reverse()
    .forEach((d, i) => {
      const v = i % 2 === 1 ? d * 2 : d;
      sum += v > 9 ? v - 9 : v;
    });
  return sum % 10 === 0;
}

/** NPI: ten digits, Luhn over 80840 + the number (HIPAA final rule, 2004). */
function npiValid(v: string): boolean {
  return /^1\d{9}$/.test(v) && luhnValid(`80840${v}`);
}

/** KVNR: letter as 01-26 + eight digits, weights 1-2-1-2…, digit sums, total mod 10. */
function kvnrValid(v: string): boolean {
  if (!/^[A-Z]\d{9}$/.test(v)) return false;
  const body = String(v.charCodeAt(0) - 64).padStart(2, '0') + v.slice(1, 9);
  let sum = 0;
  digits(body).forEach((d, i) => {
    const p = d * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 10) + (p % 10);
  });
  return sum % 10 === Number(v[9]);
}

/** LANR check digit: the first six weighted 4-9-4-9-4-9, then 10 minus the sum mod 10. */
function lanrCheck(six: string): number {
  const sum = digits(six).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 4 : 9), 0);
  return (10 - (sum % 10)) % 10;
}

/** CNS: the fifteen digits weighted 15 down to 1 sum to a multiple of 11. */
function cnsValid(v: string): boolean {
  if (!/^[12789]\d{14}$/.test(v)) return false;
  return digits(v).reduce((acc, d, i) => acc + d * (15 - i), 0) % 11 === 0;
}

/** PIS/PASEP: weights 3,2,9,8,7,6,5,4,3,2; 11 minus the sum mod 11, 10 and 11 become 0. */
function pisValid(v: string): boolean {
  const w = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = digits(v.slice(0, 10)).reduce((acc, d, i) => acc + d * (w[i] ?? 0), 0);
  const raw = 11 - (sum % 11);
  return (raw > 9 ? 0 : raw) === Number(v[10]);
}

function areaCodes(country: string): Set<string> {
  const lines = readFileSync(resolve(countries, country, 'phoneAreaCode.txt'), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

describe('the validators hold against published numbers', () => {
  it('NPI: the CMS worked example and real NPPES records', () => {
    for (const v of ['1234567893', '1993999998', '1295789295', '1639311244']) {
      expect(npiValid(v)).toBe(true);
    }
    expect(npiValid('1234567890')).toBe(false);
  });

  it('KVNR: the guideline example A123456780', () => {
    expect(kvnrValid('A123456780')).toBe(true);
    expect(kvnrValid('A123456781')).toBe(false);
  });

  it('LANR: the KBV pseudo numbers pass their own check', () => {
    expect(lanrCheck('999999')).toBe(9);
    expect(lanrCheck('333333')).toBe(3);
    expect(lanrCheck('444444')).toBe(4);
  });

  it('RPPS and FINESS: the ANS examples and the Pitié-Salpêtrière', () => {
    expect(luhnValid('10000812437')).toBe(true);
    expect(luhnValid('10000668540')).toBe(true);
    expect(luhnValid('150001899')).toBe(true);
    expect(luhnValid('750100125')).toBe(true);
    expect(luhnValid('750100120')).toBe(false);
  });

  it('CNS: the ANVISA examples', () => {
    expect(cnsValid('161243374450004')).toBe(true);
    expect(cnsValid('898000000043208')).toBe(true);
    expect(cnsValid('161243374450005')).toBe(false);
    expect(pisValid('16124337445')).toBe(true);
  });
});

describe('usa.docs.npi', () => {
  it('is ten digits starting with 1, with a Luhn digit over the 80840 prefix', () => {
    const out = pack('usa.docs.npi');
    expect(out).toHaveLength(400);
    for (const v of out) expect(npiValid(v)).toBe(true);
  });
});

describe('germany.docs.kvnr', () => {
  it('is a letter, eight digits and the guideline check digit', () => {
    const out = pack('germany.docs.kvnr');
    for (const v of out) expect(kvnrValid(v)).toBe(true);
    expect(new Set(out.map((v) => v[0])).size).toBeGreaterThan(20);
  });
});

describe('germany.docs.lanr', () => {
  it('is six digits, the 4-9 check digit and a specialty group 01-69', () => {
    for (const v of pack('germany.docs.lanr')) {
      expect(v).toMatch(/^\d{9}$/);
      expect(Number(v[6])).toBe(lanrCheck(v.slice(0, 6)));
      const group = Number(v.slice(7));
      expect(group).toBeGreaterThanOrEqual(1);
      expect(group).toBeLessThanOrEqual(69);
      expect(['333333', '444444', '555555', '999999']).not.toContain(v.slice(0, 6));
    }
  });

  it('takes the specialty as a parameter', () => {
    for (const v of render('<gen type="template" value="germany.docs.lanr" specialty="28"/>', 20)) {
      expect(v.slice(7)).toBe('28');
      expect(Number(v[6])).toBe(lanrCheck(v.slice(0, 6)));
    }
  });
});

describe('france.docs.rpps', () => {
  it('is eleven digits starting with 10, Luhn-valid', () => {
    for (const v of pack('france.docs.rpps')) {
      expect(v).toMatch(/^10\d{9}$/);
      expect(luhnValid(v)).toBe(true);
    }
  });
});

describe('france.docs.finess', () => {
  it('is a département 01-95 (not 20), a 0, five digits and a Luhn digit', () => {
    for (const v of pack('france.docs.finess')) {
      expect(v).toMatch(/^\d{2}0\d{6}$/);
      const department = Number(v.slice(0, 2));
      expect(department).toBeGreaterThanOrEqual(1);
      expect(department).toBeLessThanOrEqual(95);
      expect(department).not.toBe(20);
      expect(luhnValid(v)).toBe(true);
    }
  });
});

describe('brazil.docs.cns', () => {
  it('is a valid PIS, 000 or 001, and the Ministry of Health check digit', () => {
    const out = pack('brazil.docs.cns', 1100);
    for (const v of out) {
      expect(v).toMatch(/^[12]\d{10}00[01]\d$/);
      expect(pisValid(v.slice(0, 11))).toBe(true);
      expect(cnsValid(v)).toBe(true);
    }
    // The 001 filler is the one-in-eleven case where the first digit comes out as 10.
    expect(out.some((v) => v.slice(11, 14) === '001')).toBe(true);
  });
});

describe('North American phones on real area codes', () => {
  for (const [country, address, count] of [
    ['usa', 'usa.phone', 372],
    ['canada', 'canada.phone', 55],
  ] as const) {
    it(`${address} uses an area code from ${country}.phoneAreaCode and the fiction range`, () => {
      const codes = areaCodes(country);
      expect(codes.size).toBe(count);
      for (const v of pack(address)) {
        const m = /^\+1(\d{3})55501(\d{2})$/.exec(v);
        expect(m).not.toBeNull();
        expect(codes.has(m?.[1] ?? '')).toBe(true);
      }
    });
  }

  it('usa.phone takes the area code as a parameter', () => {
    for (const v of render('<gen type="template" value="usa.phone" area="212"/>', 20)) {
      expect(v).toMatch(/^\+121255501\d{2}$/);
    }
  });
});
