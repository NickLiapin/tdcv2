import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Polish (`pl`) locale pack and the Poland country pack. Poland carries four
 * re-derived check digits — PESEL (weighted mod-10), NIP (weighted mod-11),
 * REGON (weighted mod-11) and the IBAN (ISO 7064). The locale side guards the
 * one thing Polish gets wrong by default: adjectival surnames inflect for
 * gender, so a woman is Kowalska, never Kowalski.
 */

const here = dirname(fileURLToPath(import.meta.url));
const plDir = resolve(here, '../../../data/packs/pl');

function valuesOf(baseDir: string, relPath: string): Set<string> {
  const lines = readFileSync(join(baseDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function render(address: string, count = 40, seed = 'pl'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="pl">` +
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

function weighted(digits: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += Number(digits[i]) * weights[i]!;
  return sum;
}

describe('poland.docs.pesel', () => {
  it('is 11 digits with a valid weighted mod-10 check digit', () => {
    const out = render('poland.docs.pesel', 60);
    expect(out).toHaveLength(60);
    for (const v of out) {
      expect(v).toMatch(/^\d{11}$/);
      const sum = weighted(v, [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]);
      expect((10 - (sum % 10)) % 10, v).toBe(Number(v[10]));
    }
  });
});

describe('poland.tax.regon', () => {
  it('is 9 digits with a valid weighted mod-11 check digit', () => {
    for (const v of render('poland.tax.regon', 60)) {
      expect(v).toMatch(/^[1-9]\d{8}$/);
      const sum = weighted(v, [8, 9, 2, 3, 4, 5, 6, 7]);
      expect((sum % 11) % 10, v).toBe(Number(v[8]));
    }
  });
});

describe('poland.tax.nip', () => {
  it('is 10 digits with a valid weighted mod-11 check digit', () => {
    for (const v of render('poland.tax.nip', 60)) {
      expect(v).toMatch(/^\d{10}$/);
      const sum = weighted(v, [6, 5, 7, 2, 3, 4, 5, 6, 7]);
      expect(sum % 11, v).toBe(Number(v[9]));
    }
  });
});

describe('poland.finance.iban', () => {
  it('is PL + 26 digits with a valid ISO 7064 check', () => {
    for (const v of render('poland.finance.iban', 30)) {
      expect(v).toMatch(/^PL\d{26}$/);
      expect(ibanIsoOk(v), v).toBe(true);
    }
  });
});

describe('pl.person surnames inflect for gender', () => {
  it('never gives a woman a masculine adjectival surname', () => {
    for (const v of render('pl.person.female.fullName', 80)) {
      const surname = v.trim().split(/\s+/).slice(1).join(' ');
      // -ski / -cki / -dzki are the masculine forms; a woman takes -ska / -cka / -dzka.
      expect(surname, v).not.toMatch(/(ski|cki|zki)$/);
    }
  });

  it('keeps the masculine form for men', () => {
    const surnames = render('pl.person.male.fullName', 80).map((v) =>
      v.trim().split(/\s+/).slice(1).join(' '),
    );
    expect(surnames.some((s) => /(ski|cki)$/.test(s))).toBe(true);
    expect(surnames.every((s) => !/(ska|cka)$/.test(s))).toBe(true);
  });

  it('leaves nominal surnames untouched in both lists', () => {
    const male = valuesOf(plDir, 'person/lastName.txt');
    const female = valuesOf(plDir, 'person/female/lastName.txt');
    for (const nominal of ['Nowak', 'Wójcik', 'Kowalczyk', 'Mazur', 'Wilk']) {
      expect(male.has(nominal), nominal).toBe(true);
      expect(female.has(nominal), nominal).toBe(true);
    }
    // The two lists stay the same length so they remain line-for-line parallel.
    expect(female.size).toBe(male.size);
  });
});

describe('pl coherent lists', () => {
  it.each([
    ['food.cuisine', 'food.dishByCuisine', 'food/dishByCuisine'],
    ['work.industryCoherent', 'work.jobByIndustry', 'work/jobByIndustry'],
    ['medical.specialtyCoherent', 'medical.diagnosisBySpecialty', 'medical/diagnosisBySpecialty'],
    ['sport.sportCoherent', 'sport.positionBySport', 'sport/positionBySport'],
  ] as const)('%s → %s stays on the parent drawn for that row', (parent, child, dir) => {
    const cfg = [
      '<tdc><env count="48" seed="spójne" local="pl">',
      `  <sequence name="A"><gen type="template" value="pl.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="pl.${child}.\${{A}}"/></sequence>`,
      '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [a, b] = row.split('|');
      expect(valuesOf(plDir, `${dir}/${a ?? ''}.txt`).has(b ?? ''), row).toBe(true);
    }
  });
});

describe('pl dates', () => {
  it('inflect the month name inside a date (genitive, not nominative)', () => {
    const cfg =
      '<tdc><env count="12" seed="kal" local="pl">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LLLL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    expect(out).toMatch(
      /stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia/,
    );
    // The nominative belongs in the data pack, never in a rendered date.
    expect(out).not.toMatch(/styczeń|październik|sierpień|wrzesień|grudzień/);
    expect(out).toMatch(/poniedziałek|wtorek|środa|czwartek|piątek|sobota|niedziela/);
  });

  it('keeps the nominative in the data pack list', () => {
    const months = valuesOf(plDir, 'date/month.txt');
    expect(months.has('styczeń')).toBe(true);
    expect(months.has('październik')).toBe(true);
  });
});

describe('Poland pack resolves', () => {
  const addresses = [
    'poland.tax.vat',
    'poland.geo.voivodeship',
    'poland.geo.city',
    'poland.geo.postalCode',
    'poland.finance.bank',
    'poland.phone',
    'poland.vehicle.plate',
    'poland.holiday',
    'poland.sport.team',
    'poland.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('Polish pack determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('poland.docs.pesel', 20, 'x')).toEqual(render('poland.docs.pesel', 20, 'x'));
  });
});
