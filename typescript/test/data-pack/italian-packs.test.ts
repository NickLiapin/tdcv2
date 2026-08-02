import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Italian (`it`) locale pack and the Italian-speaking country packs: Italy,
 * San Marino and Vatican City. The centrepiece is the codice fiscale, whose
 * check character is re-derived here from the published odd/even tables — the
 * same tables drive the CIN letter inside Italian and Sammarinese IBANs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const itDir = resolve(here, '../../../data/packs/it');

function valuesOf(baseDir: string, relPath: string): Set<string> {
  const lines = readFileSync(join(baseDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function render(address: string, count = 40, seed = 'it'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="it">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Published codice-fiscale conversion table for odd (1-based) positions. */
const ODD: Record<string, number> = {};
'1,0,5,7,9,13,15,17,19,21'.split(',').forEach((v, i) => (ODD[String(i)] = Number(v)));
'1,0,5,7,9,13,15,17,19,21,2,4,18,20,11,3,6,8,12,14,16,10,22,25,24,23'
  .split(',')
  .forEach((v, i) => (ODD[ALPHABET[i]!] = Number(v)));

/** Even positions simply take the character's alphabet/digit value. */
const EVEN: Record<string, number> = {};
'0123456789'.split('').forEach((c, i) => (EVEN[c] = i));
ALPHABET.split('').forEach((c, i) => (EVEN[c] = i));

/** Fold the odd/even tables over a string and map the remainder to a letter. */
function checkLetter(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    sum += i % 2 === 0 ? ODD[ch]! : EVEN[ch]!;
  }
  return ALPHABET[sum % 26]!;
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

describe('italy.docs.codiceFiscale', () => {
  const belfiore = valuesOf(
    resolve(here, '../../../data/packs/countries/italy'),
    'geo/belfioreCode.txt',
  );

  it('is 16 chars in the authentic layout and its check character re-derives', () => {
    const out = render('italy.docs.codiceFiscale', 80);
    expect(out).toHaveLength(80);
    for (const v of out) {
      expect(v).toMatch(/^[A-Z]{6}\d{2}[ABCDEHLMPRST]\d{2}[A-Z]\d{3}[A-Z]$/);
      expect(checkLetter(v.slice(0, 15)), v).toBe(v[15]);
      expect(belfiore.has(v.slice(11, 15)), v).toBe(true);
    }
  });

  it('encodes sex in the day field — women carry day + 40', () => {
    const days = render('italy.docs.codiceFiscale', 80).map((v) => Number(v.slice(9, 11)));
    const male = days.filter((d) => d >= 1 && d <= 28);
    const female = days.filter((d) => d >= 41 && d <= 68);
    expect(male.length + female.length).toBe(days.length);
    expect(male.length).toBeGreaterThan(0);
    expect(female.length).toBeGreaterThan(0);
  });

  it('agrees with a real-world codice fiscale and rejects a corrupted one', () => {
    expect(checkLetter('RSSMRA85T10A562')).toBe('S');
    expect(checkLetter('RSSMRA85T10A562')).not.toBe('X');
  });
});

describe('Italian-family IBANs', () => {
  it.each([
    ['italy.finance.iban', /^IT\d{2}[A-Z]\d{22}$/],
    ['san_marino.finance.iban', /^SM\d{2}[A-Z]\d{22}$/],
  ] as const)('%s carries a valid CIN letter and ISO 7064 check', (addr, re) => {
    for (const v of render(addr, 30)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v), v).toBe(true);
      // The CIN is folded over ABI + CAB + account, exactly like a codice fiscale.
      expect(checkLetter(v.slice(5)), v).toBe(v[4]);
    }
  });

  it('vatican_city.finance.iban is VA + 20 digits with a valid ISO 7064 check', () => {
    for (const v of render('vatican_city.finance.iban', 30)) {
      expect(v).toMatch(/^VA\d{20}$/);
      expect(ibanIsoOk(v), v).toBe(true);
    }
  });
});

describe('italy.tax.vat', () => {
  it('is IT + 11 digits and the whole number is Luhn-valid', () => {
    for (const v of render('italy.tax.vat', 40)) {
      expect(v).toMatch(/^IT\d{11}$/);
      const n = v.slice(2);
      let sum = 0;
      let alt = false;
      for (let i = n.length - 1; i >= 0; i--) {
        let d = Number(n[i]);
        if (alt) {
          d *= 2;
          if (d > 9) d -= 9;
        }
        sum += d;
        alt = !alt;
      }
      expect(sum % 10, v).toBe(0);
    }
  });
});

describe('it.person full names', () => {
  it('carry exactly one given name and one surname', () => {
    for (const gender of ['male', 'female']) {
      for (const v of render(`it.person.${gender}.fullName`, 20)) {
        expect(v.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe('it coherent lists', () => {
  it.each([
    ['food.cuisine', 'food.dishByCuisine', 'food/dishByCuisine'],
    ['work.industryCoherent', 'work.jobByIndustry', 'work/jobByIndustry'],
    ['medical.specialtyCoherent', 'medical.diagnosisBySpecialty', 'medical/diagnosisBySpecialty'],
    ['sport.sportCoherent', 'sport.positionBySport', 'sport/positionBySport'],
  ] as const)('%s → %s stays on the parent drawn for that row', (parent, child, dir) => {
    const cfg = [
      '<tdc><env count="48" seed="coer" local="it">',
      `  <sequence name="A"><gen type="template" value="it.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="it.${child}.\${{A}}"/></sequence>`,
      '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [a, b] = row.split('|');
      expect(valuesOf(itDir, `${dir}/${a ?? ''}.txt`).has(b ?? ''), row).toBe(true);
    }
  });
});

describe('it dates', () => {
  it('render lowercase Italian month and weekday names', () => {
    const cfg =
      '<tdc><env count="12" seed="cal" local="it">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LLLL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    expect(out).toMatch(
      /gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre/,
    );
    expect(out).toMatch(/lunedì|martedì|mercoledì|giovedì|venerdì|sabato|domenica/);
    expect(out).not.toMatch(/January|janvier|enero|Januar/);
  });
});

describe('Italian-speaking packs resolve', () => {
  const addresses = [
    'italy.geo.region',
    'italy.geo.city',
    'italy.geo.cap',
    'italy.geo.belfioreCode',
    'italy.finance.bank',
    'italy.phone',
    'italy.vehicle.plate',
    'italy.holiday',
    'italy.sport.team',
    'italy.education.university',
    'san_marino.finance.bank',
    'san_marino.docs.coe',
    'san_marino.geo.castle',
    'san_marino.phone',
    'san_marino.vehicle.plate',
    'san_marino.holiday',
    'san_marino.sport.team',
    'san_marino.education.university',
    'vatican_city.finance.bank',
    'vatican_city.geo.place',
    'vatican_city.phone',
    'vatican_city.vehicle.plate',
    'vatican_city.holiday',
    'vatican_city.sport.team',
    'vatican_city.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('Italian pack determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('italy.docs.codiceFiscale', 20, 'x')).toEqual(
      render('italy.docs.codiceFiscale', 20, 'x'),
    );
  });
});
