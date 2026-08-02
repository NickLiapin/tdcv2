import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/** Validity test for US presets migrated to bundled compute packs. */

function render(address: string, count = 40, seed = 'usa'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function abaOk(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(routing[i]) * (w[i] ?? 0);
  return sum % 10 === 0;
}

const EIN_PREFIXES = new Set(
  '01,02,03,04,05,06,10,11,12,13,14,15,16,20,21,22,23,24,25,26,27,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,71,72,73,74,75,76,77,80,81,82,83,84,85,86,87,88,90,91,92,93,94,95,98,99'.split(
    ',',
  ),
);
const ITIN_GROUPS = new Set(
  '50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,90,91,92,94,95,96,97,98,99'.split(
    ',',
  ),
);

describe('usa.finance.aba_routing', () => {
  it('produces valid 9-digit ABA routing numbers', () => {
    const out = render('usa.finance.aba_routing');
    expect(out.length).toBe(40);
    for (const v of out) expect(abaOk(v)).toBe(true);
  });
});

describe('usa.docs.ssn', () => {
  it('produces a structurally valid SSN (area != 000/666, group 01-99, serial 0001-9999)', () => {
    for (const v of render('usa.docs.ssn')) {
      expect(v).toMatch(/^\d{9}$/);
      const area = Number(v.slice(0, 3));
      const group = Number(v.slice(3, 5));
      const serial = Number(v.slice(5));
      expect(area).toBeGreaterThanOrEqual(1);
      expect(area).toBeLessThanOrEqual(899);
      expect(area).not.toBe(666);
      expect(group).toBeGreaterThanOrEqual(1);
      expect(serial).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('usa.tax.ein / itin', () => {
  it('EIN has a valid IRS prefix + 7 digits', () => {
    for (const v of render('usa.tax.ein')) {
      expect(v).toMatch(/^\d{9}$/);
      expect(EIN_PREFIXES.has(v.slice(0, 2))).toBe(true);
    }
  });

  it('ITIN is 9 + 2 + valid group + 4 digits', () => {
    for (const v of render('usa.tax.itin')) {
      expect(v).toMatch(/^9\d{8}$/);
      expect(ITIN_GROUPS.has(v.slice(3, 5))).toBe(true);
    }
  });
});

describe('usa.geo.streetName', () => {
  // Mostly numbered streets, ~20% named. The numbered part is a generator: a
  // number plus the right ordinal suffix. The suffix is the whole trick —
  // 11th/12th/13th are "th", not 11st/12nd/13rd, and that holds at 111/112/113.
  const expectedSuffix = (n: number): string => {
    const m100 = n % 100;
    if (m100 === 11 || m100 === 12 || m100 === 13) return 'th';
    const m10 = n % 10;
    return m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th';
  };

  it('numbered values carry the correct ordinal suffix; some are named', () => {
    const out = render('usa.geo.streetName', 3000);
    let numbered = 0;
    let named = 0;
    for (const v of out) {
      const m = /^(\d+)(st|nd|rd|th)$/.exec(v);
      if (m) {
        numbered++;
        const n = Number(m[1]);
        expect(m[2], `${String(n)} has the wrong suffix`).toBe(expectedSuffix(n));
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(150);
      } else {
        named++;
      }
    }
    // The mix is a per-row uniform draw (1..5, name on 5), so ~20% named —
    // loose bounds, the point is that BOTH appear, in both engines.
    expect(named).toBeGreaterThan(numbered / 10);
    expect(named).toBeLessThan(numbered);
  });

  it('the named list resolves and is non-trivial', () => {
    const out = new Set(render('usa.geo.streetNamed', 500));
    expect(out.has('Main')).toBe(true);
    expect(out.size).toBeGreaterThan(20);
  });
});

describe('usa.geo.zip', () => {
  // A generator, not a list: for fake data a ZIP need not match a real city, so
  // shipping 40 000 rows (and a CC-BY licence) buys nothing. It only has to
  // LOOK like a ZIP — five digits, leading zeros kept, within the real range.
  it('is 5 digits in the valid ZIP range, leading zeros preserved', () => {
    const out = render('usa.geo.zip', 2000);
    expect(out.length).toBe(2000);
    for (const v of out) {
      expect(v).toMatch(/^\d{5}$/);
      const n = Number(v);
      expect(n).toBeGreaterThanOrEqual(501);
      expect(n).toBeLessThanOrEqual(99950);
    }
    // Northeast ZIPs start with 0; a pure Number() would have dropped them.
    expect(out.some((v) => v.startsWith('0'))).toBe(true);
  });
});
