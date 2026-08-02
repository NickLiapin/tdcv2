import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Arabic locale pack (data/packs/ar) and the Egypt base country pack. Egypt's
 * national ID carries an authentic structure (century + birth date + governorate
 * + gender-parity serial) with a Luhn check re-derived here; the ar pack checks
 * the three-part name form, the coherent parent->child lists, and RTL dates.
 */

const here = dirname(fileURLToPath(import.meta.url));
const arDir = resolve(here, '../../../data/packs/ar');
const egDir = resolve(here, '../../../data/packs/countries/egypt');

function valuesOf(baseDir: string, relPath: string): Set<string> {
  const lines = readFileSync(join(baseDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function render(address: string, count = 60, seed = 'ar'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="ar">` +
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

describe('egypt.docs.nationalId', () => {
  const govCodes = valuesOf(egDir, 'geo/governorateCode.txt');
  it('is 14 digits with an authentic structure and a valid Luhn check', () => {
    const out = render('egypt.docs.nationalId');
    expect(out).toHaveLength(60);
    for (const v of out) {
      expect(v).toMatch(/^[23]\d{13}$/);
      expect(luhnValid(v)).toBe(true);
      // Century digit agrees with the birth year.
      const year = (v.startsWith('2') ? '19' : '20') + v.slice(1, 3);
      expect(Number(year)).toBeGreaterThanOrEqual(1960);
      expect(Number(year)).toBeLessThanOrEqual(2004);
      const month = Number(v.slice(3, 5));
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      // Governorate code is a real one.
      expect(govCodes.has(v.slice(7, 9))).toBe(true);
    }
  });
});

describe('egypt.finance.iban', () => {
  it('is EG + 27 digits with a valid ISO 7064 check', () => {
    for (const v of render('egypt.finance.iban')) {
      expect(v).toMatch(/^EG\d{27}$/);
      const rearranged = v.slice(4) + v.slice(0, 4);
      let expanded = '';
      for (const ch of rearranged)
        expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      expect(mod97(expanded)).toBe(1);
    }
  });
});

function ibanIsoOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  return mod97(expanded) === 1;
}

describe('saudi_arabia.docs.nationalId', () => {
  it('is 10 digits starting 1 or 2 and Luhn-valid', () => {
    for (const v of render('saudi_arabia.docs.nationalId')) {
      expect(v).toMatch(/^[12]\d{9}$/);
      expect(luhnValid(v)).toBe(true);
    }
  });
});

describe('uae.docs.emiratesId', () => {
  it('is 784-YYYY-NNNNNNN-C (15 digits) and Luhn-valid', () => {
    for (const v of render('uae.docs.emiratesId')) {
      expect(v).toMatch(/^784-\d{4}-\d{7}-\d$/);
      const digits = v.replace(/-/g, '');
      expect(digits).toHaveLength(15);
      expect(luhnValid(digits)).toBe(true);
    }
  });
});

describe('gulf IBANs carry a valid ISO 7064 check', () => {
  it.each([
    ['saudi_arabia.finance.iban', /^SA\d{22}$/],
    ['uae.finance.iban', /^AE\d{21}$/],
    ['qatar.finance.iban', /^QA\d{27}$/],
    ['kuwait.finance.iban', /^KW\d{28}$/],
    ['bahrain.finance.iban', /^BH\d{20}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 30)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('levant IBANs carry a valid ISO 7064 check', () => {
  it.each([
    ['jordan.finance.iban', /^JO\d{28}$/],
    ['lebanon.finance.iban', /^LB\d{26}$/],
    ['iraq.finance.iban', /^IQ\d{21}$/],
    ['palestine.finance.iban', /^PS\d{27}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 30)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('maghreb + horn IBANs carry a valid ISO 7064 check', () => {
  it.each([
    ['tunisia.finance.iban', /^TN\d{22}$/],
    ['libya.finance.iban', /^LY\d{23}$/],
    ['sudan.finance.iban', /^SD\d{16}$/],
    ['mauritania.finance.iban', /^MR\d{25}$/],
    ['comoros.finance.iban', /^KM\d{25}$/],
    ['somalia.finance.iban', /^SO\d{21}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 30)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v)).toBe(true);
    }
  });
});

describe('ar.person full names', () => {
  it('carry three parts (given + father + family)', () => {
    for (const gender of ['male', 'female']) {
      for (const v of render(`ar.person.${gender}.fullName`, 20)) {
        expect(v.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('ar coherent lists', () => {
  it('every dish belongs to the cuisine drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="menu" local="ar">',
      '  <sequence name="C"><gen type="template" value="ar.food.cuisine"/></sequence>',
      '  <sequence name="D" parent="C"><gen type="template" value="ar.food.dishByCuisine.${{C}}"/></sequence>',
      '</env><block><line><data>${{C}}|${{D}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [c, d] = row.split('|');
      expect(valuesOf(arDir, `food/dishByCuisine/${c ?? ''}.txt`).has(d ?? ''), row).toBe(true);
    }
  });

  it('every position belongs to the sport drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="team" local="ar">',
      '  <sequence name="S"><gen type="template" value="ar.sport.sportCoherent"/></sequence>',
      '  <sequence name="P" parent="S"><gen type="template" value="ar.sport.positionBySport.${{S}}"/></sequence>',
      '</env><block><line><data>${{S}}|${{P}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [s, p] = row.split('|');
      expect(valuesOf(arDir, `sport/positionBySport/${s ?? ''}.txt`).has(p ?? ''), row).toBe(true);
    }
  });
});

describe('ar dates', () => {
  it('render Arabic month names in the long form', () => {
    const cfg =
      '<tdc><env count="12" seed="cal" local="ar">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    expect(out).toMatch(
      /يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر/,
    );
    expect(out).not.toMatch(/January|janvier|enero/);
  });
});

describe('ar determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('egypt.docs.nationalId', 20, 'x')).toEqual(
      render('egypt.docs.nationalId', 20, 'x'),
    );
  });
});
