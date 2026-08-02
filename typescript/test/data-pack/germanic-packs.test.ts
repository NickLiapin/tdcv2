import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * German (`de`) locale pack and the German-speaking country packs: Germany,
 * Austria and Liechtenstein. Germany's tax ID and VAT number both use ISO 7064
 * MOD 11,10; Austria's UID uses a Luhn-style weighting with a (96 - sum) mod 10
 * check. All three IBANs are re-derived here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const deDir = resolve(here, '../../../data/packs/de');

function valuesOf(baseDir: string, relPath: string): Set<string> {
  const lines = readFileSync(join(baseDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function render(address: string, count = 40, seed = 'de'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="de">` +
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

/** ISO 7064 MOD 11,10 — the German Steuer-ID and USt-IdNr check digit. */
function mod1110Check(base: string): number {
  let product = 10;
  for (const ch of base) {
    let sum = (Number(ch) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = 11 - product;
  return check === 10 ? 0 : check;
}

/** Austrian UID: every second digit doubled and reduced, check = (96 - sum) mod 10. */
function atuValid(v: string): boolean {
  if (!/^ATU\d{8}$/.test(v)) return false;
  const d = v.slice(3);
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    let x = Number(d[i]);
    if (i % 2 === 1) {
      x *= 2;
      if (x > 9) x -= 9;
    }
    sum += x;
  }
  return (96 - sum) % 10 === Number(d[7]);
}

describe('germany.docs.taxId', () => {
  it('is 11 digits and its ISO 7064 MOD 11,10 check digit re-derives', () => {
    const out = render('germany.docs.taxId', 80);
    expect(out).toHaveLength(80);
    for (const v of out) {
      expect(v).toMatch(/^[1-9]\d{10}$/);
      expect(mod1110Check(v.slice(0, 10)), v).toBe(Number(v[10]));
    }
  });
});

describe('germany.tax.vat', () => {
  it('is DE + 9 digits with a valid MOD 11,10 check digit', () => {
    for (const v of render('germany.tax.vat', 60)) {
      expect(v).toMatch(/^DE\d{9}$/);
      const digits = v.slice(2);
      expect(mod1110Check(digits.slice(0, 8)), v).toBe(Number(digits[8]));
    }
  });
});

describe('austria.tax.vat', () => {
  it('is ATU + 8 digits whose Luhn-style check digit re-derives', () => {
    for (const v of render('austria.tax.vat', 60)) expect(atuValid(v), v).toBe(true);
  });

  it('accepts a known-good real Austrian UID', () => {
    expect(atuValid('ATU13585627')).toBe(true);
    expect(atuValid('ATU13585628')).toBe(false);
  });
});

describe('German-speaking IBANs carry a valid ISO 7064 check', () => {
  it.each([
    ['germany.finance.iban', /^DE\d{20}$/],
    ['austria.finance.iban', /^AT\d{18}$/],
    ['liechtenstein.finance.iban', /^LI\d{19}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 30)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v), v).toBe(true);
    }
  });
});

describe('de.person full names', () => {
  it('carry exactly one given name and one surname', () => {
    for (const gender of ['male', 'female']) {
      for (const v of render(`de.person.${gender}.fullName`, 20)) {
        expect(v.trim().split(/\s+/).length).toBe(2);
      }
    }
  });
});

describe('de coherent lists', () => {
  it('every dish belongs to the cuisine drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="essen" local="de">',
      '  <sequence name="C"><gen type="template" value="de.food.cuisine"/></sequence>',
      '  <sequence name="D" parent="C"><gen type="template" value="de.food.dishByCuisine.${{C}}"/></sequence>',
      '</env><block><line><data>${{C}}|${{D}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [c, d] = row.split('|');
      expect(valuesOf(deDir, `food/dishByCuisine/${c ?? ''}.txt`).has(d ?? ''), row).toBe(true);
    }
  });

  it('every diagnosis belongs to the specialty drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="arzt" local="de">',
      '  <sequence name="S"><gen type="template" value="de.medical.specialtyCoherent"/></sequence>',
      '  <sequence name="D" parent="S"><gen type="template" value="de.medical.diagnosisBySpecialty.${{S}}"/></sequence>',
      '</env><block><line><data>${{S}}|${{D}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [s, d] = row.split('|');
      expect(valuesOf(deDir, `medical/diagnosisBySpecialty/${s ?? ''}.txt`).has(d ?? ''), row).toBe(
        true,
      );
    }
  });

  it('every position belongs to the sport drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="sport" local="de">',
      '  <sequence name="S"><gen type="template" value="de.sport.sportCoherent"/></sequence>',
      '  <sequence name="P" parent="S"><gen type="template" value="de.sport.positionBySport.${{S}}"/></sequence>',
      '</env><block><line><data>${{S}}|${{P}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [s, p] = row.split('|');
      expect(valuesOf(deDir, `sport/positionBySport/${s ?? ''}.txt`).has(p ?? ''), row).toBe(true);
    }
  });

  it('every job belongs to the industry drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="beruf" local="de">',
      '  <sequence name="I"><gen type="template" value="de.work.industryCoherent"/></sequence>',
      '  <sequence name="J" parent="I"><gen type="template" value="de.work.jobByIndustry.${{I}}"/></sequence>',
      '</env><block><line><data>${{I}}|${{J}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [i, j] = row.split('|');
      expect(valuesOf(deDir, `work/jobByIndustry/${i ?? ''}.txt`).has(j ?? ''), row).toBe(true);
    }
  });
});

describe('de dates', () => {
  it('render capitalised German month and weekday names', () => {
    const cfg =
      '<tdc><env count="12" seed="kal" local="de">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LLLL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    expect(out).toMatch(
      /Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember/,
    );
    expect(out).toMatch(/Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag/);
    expect(out).not.toMatch(/January|janvier|enero|janeiro/);
  });
});

describe('German-speaking packs resolve', () => {
  const addresses = [
    'germany.geo.state',
    'germany.geo.stateCode',
    'germany.geo.city',
    'germany.geo.postalCode',
    'germany.finance.bank',
    'germany.finance.blz',
    'germany.vehicle.plate',
    'germany.holiday',
    'germany.sport.team',
    'germany.education.university',
    'austria.geo.state',
    'austria.geo.city',
    'austria.geo.postalCode',
    'austria.finance.bank',
    'austria.phone',
    'austria.vehicle.plate',
    'austria.holiday',
    'austria.sport.team',
    'austria.education.university',
    'liechtenstein.geo.municipality',
    'liechtenstein.finance.bank',
    'liechtenstein.phone',
    'liechtenstein.vehicle.plate',
    'liechtenstein.holiday',
    'liechtenstein.sport.team',
    'liechtenstein.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('German-speaking pack determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('germany.docs.taxId', 20, 'x')).toEqual(render('germany.docs.taxId', 20, 'x'));
    expect(render('austria.tax.vat', 20, 'x')).toEqual(render('austria.tax.vat', 20, 'x'));
  });
});
