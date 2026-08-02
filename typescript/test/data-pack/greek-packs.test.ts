import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Greek (`el`) locale pack. Greece already had a country pack; this completes it
 * with people, medicine and everyday vocabulary. Two things need guarding:
 * Greek surnames inflect for gender, and a rendered date takes the genitive
 * month while the pack list keeps the nominative.
 */

const here = dirname(fileURLToPath(import.meta.url));
const elDir = resolve(here, '../../../data/packs/el');

function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(elDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function listOf(relPath: string): string[] {
  const lines = readFileSync(join(elDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return lines.slice(end + 1).filter((l) => l.trim() !== '');
}

function render(address: string, count = 40, seed = 'el'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="el">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('el.person surnames inflect for gender', () => {
  it('keeps the two surname lists parallel, line for line', () => {
    expect(listOf('person/female/lastName.txt')).toHaveLength(listOf('person/lastName.txt').length);
  });

  it('never gives a woman a masculine -ος surname', () => {
    for (const v of render('el.person.female.fullName', 80)) {
      const surname = v.trim().split(/\s+/).slice(1).join(' ');
      expect(surname, v).not.toMatch(/(ος|ός|ης|ής)$/);
    }
  });

  it('still uses the masculine form for men', () => {
    const surnames = render('el.person.male.fullName', 80).map((v) =>
      v.trim().split(/\s+/).slice(1).join(' '),
    );
    expect(surnames.some((s) => /(ος|ός|ης|ής)$/.test(s))).toBe(true);
  });

  it('shifts the accent where Greek requires it', () => {
    const male = listOf('person/lastName.txt');
    const female = listOf('person/female/lastName.txt');
    const at = male.indexOf('Παπαδόπουλος');
    expect(at).toBeGreaterThanOrEqual(0);
    // The accent moves off the antepenult: Παπαδόπουλος → Παπαδοπούλου.
    expect(female[at]).toBe('Παπαδοπούλου');
  });

  it('leaves surnames that are already genitive untouched', () => {
    const male = listOf('person/lastName.txt');
    const female = listOf('person/female/lastName.txt');
    for (const invariant of ['Παπαγεωργίου', 'Σωτηρίου']) {
      const at = male.indexOf(invariant);
      expect(at, invariant).toBeGreaterThanOrEqual(0);
      expect(female[at]).toBe(invariant);
    }
  });
});

describe('el coherent lists', () => {
  it.each([
    ['food.cuisine', 'food.dishByCuisine', 'food/dishByCuisine'],
    ['work.industryCoherent', 'work.jobByIndustry', 'work/jobByIndustry'],
    ['medical.specialtyCoherent', 'medical.diagnosisBySpecialty', 'medical/diagnosisBySpecialty'],
    ['sport.sportCoherent', 'sport.positionBySport', 'sport/positionBySport'],
  ] as const)('%s → %s stays on the parent drawn for that row', (parent, child, dir) => {
    const cfg = [
      '<tdc><env count="48" seed="συνοχή" local="el">',
      `  <sequence name="A"><gen type="template" value="el.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="el.${child}.\${{A}}"/></sequence>`,
      '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [a, b] = row.split('|');
      expect(valuesOf(`${dir}/${a ?? ''}.txt`).has(b ?? ''), row).toBe(true);
    }
  });
});

describe('el dates', () => {
  it('inflect the month inside a date and keep the nominative in the pack', () => {
    const cfg =
      '<tdc><env count="12" seed="cal" local="el">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LLLL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    expect(out).toMatch(
      /Ιανουαρίου|Φεβρουαρίου|Μαρτίου|Απριλίου|Μαΐου|Ιουνίου|Ιουλίου|Αυγούστου|Σεπτεμβρίου|Οκτωβρίου|Νοεμβρίου|Δεκεμβρίου/,
    );
    expect(out).not.toMatch(/Ιανουάριος|Οκτώβριος|Αύγουστος|Δεκέμβριος/);
    const months = valuesOf('date/month.txt');
    expect(months.has('Ιανουάριος')).toBe(true);
    expect(months.has('Οκτώβριος')).toBe(true);
  });
});

describe('el renders in Greek script', () => {
  it.each([
    'el.person.male.fullName',
    'el.medical.diagnosis',
    'el.work.jobTitle',
    'el.food.dish',
    'el.location.country',
    'el.government.agency',
    'el.legal.court',
  ] as const)('%s', (addr) => {
    for (const v of render(addr, 10)) expect(v).toMatch(/[Ͱ-Ͽἀ-῿]/);
  });
});

describe('el pack shape', () => {
  it('carries the shared 233-entry country list', () => {
    expect(listOf('location/country.txt')).toHaveLength(233);
  });

  it('is reproducible for a fixed seed', () => {
    expect(render('el.person.female.fullName', 20, 'x')).toEqual(
      render('el.person.female.fullName', 20, 'x'),
    );
  });
});
