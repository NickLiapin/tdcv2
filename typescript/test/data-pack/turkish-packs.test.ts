import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Turkish (`tr`) locale pack. Two things about Turkish are easy to get wrong
 * and neither shows up in a line count, so both are asserted here:
 *
 *   * the alphabet. Turkish has ç ğ ı İ ö ş ü and does NOT have q, w or x. A
 *     list transliterated from English keeps its q/w/x and reads as Turkish to
 *     anyone not looking closely.
 *   * surnames do not inflect. Unlike Polish or Ukrainian, a Turkish woman
 *     carries exactly the surname her husband and sons carry, so there is no
 *     person/female/lastName.txt — its absence is the design, not a gap.
 */

const here = dirname(fileURLToPath(import.meta.url));
const trDir = resolve(here, '../../../data/packs/tr');

/** Values of a pack list file, past the fence, with any weight column stripped. */
function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(trDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(
    lines
      .slice(end + 1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/,\d+$/, '')),
  );
}

function render(address: string, count = 40, seed = 'tr'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="tr">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function everyListFile(dir = trDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...everyListFile(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.txt')) out.push(rel);
  }
  return out;
}

describe('tr is written in the Turkish alphabet', () => {
  it('uses ç, ğ, ı, ö, ş and ü across the pack', () => {
    const text = everyListFile()
      .map((f) => readFileSync(join(trDir, f), 'utf8'))
      .join('\n');
    for (const letter of ['ç', 'ğ', 'ı', 'ö', 'ş', 'ü']) {
      expect(text.includes(letter), `no "${letter}" anywhere in the pack`).toBe(true);
    }
  });

  /**
   * q, w and x are not Turkish letters. They do appear legitimately in borrowed
   * brand and model names (Wi-Fi, Xbox, A320), so the check is limited to the
   * lists that are supposed to be Turkish words throughout.
   */
  it('has no q, w or x in the lists that are pure Turkish vocabulary', () => {
    const turkishOnly = [
      'word/noun.txt',
      'word/verb.txt',
      'word/adjective.txt',
      'word/adverb.txt',
      'person/male/firstName.txt',
      'person/female/firstName.txt',
      'person/lastName.txt',
      'date/month.txt',
      'date/weekday.txt',
      'color/name.txt',
      'nature/tree.txt',
      'nature/flower.txt',
    ];
    for (const file of turkishOnly) {
      for (const value of valuesOf(file)) {
        expect(/[qwx]/i.test(value), `${file}: "${value}" uses a non-Turkish letter`).toBe(false);
      }
    }
  });
});

describe('tr.person', () => {
  it('draws surnames from the Turkish list', () => {
    const surnames = valuesOf('person/lastName.txt');
    for (const v of render('tr.person.lastName', 40)) expect(surnames.has(v), v).toBe(true);
  });

  it('gives male and female rows their own given-name lists', () => {
    const male = valuesOf('person/male/firstName.txt');
    const female = valuesOf('person/female/firstName.txt');
    for (const v of render('tr.person.male.firstName', 30)) expect(male.has(v), v).toBe(true);
    for (const v of render('tr.person.female.firstName', 30)) expect(female.has(v), v).toBe(true);
    expect([...male].filter((n) => female.has(n))).toHaveLength(0);
  });

  /**
   * The surname a man draws and the surname a woman draws come from the SAME
   * file, because Turkish surnames do not inflect. If someone later adds a
   * person/female/lastName.txt the two would silently diverge, so the absence is
   * asserted rather than assumed.
   */
  it('has one surname list for both genders, because Turkish surnames do not inflect', () => {
    expect(everyListFile().includes('person/female/lastName.txt')).toBe(false);
    const shared = valuesOf('person/lastName.txt');
    for (const v of render('tr.person.lastName', 40, 'kadın')) expect(shared.has(v), v).toBe(true);
    for (const v of render('tr.person.lastName', 40, 'erkek')) expect(shared.has(v), v).toBe(true);
  });
});

describe('tr person lists that carry a count', () => {
  it('declare weighted: true, so the count is a weight and not part of the name', () => {
    for (const file of [
      'person/lastName.txt',
      'person/male/firstName.txt',
      'person/female/firstName.txt',
    ]) {
      const text = readFileSync(join(trDir, file), 'utf8');
      expect(text.includes('\nweighted: true\n'), `${file} has a count column but no header`).toBe(
        true,
      );
    }
  });
});

const COHERENT: [string, string, string][] = [
  ['food.cuisine', 'food.dishByCuisine', 'food/dishByCuisine'],
  ['work.industryCoherent', 'work.jobByIndustry', 'work/jobByIndustry'],
  ['medical.specialtyCoherent', 'medical.diagnosisBySpecialty', 'medical/diagnosisBySpecialty'],
  ['medical.ancestry', 'medical.diagnosisByAncestry', 'medical/diagnosisByAncestry'],
  ['sport.sportCoherent', 'sport.positionBySport', 'sport/positionBySport'],
];

describe.each(COHERENT)('tr coherent %s', (parent, child, dir) => {
  it('every child value belongs to the parent drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="pair" local="tr">',
      `  <sequence name="A"><gen type="template" value="tr.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="tr.${child}.\${{A}}"/></sequence>`,
      '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [key, value] = row.split('|');
      expect(key, row).toBeTruthy();
      expect(
        valuesOf(`${dir}/${key ?? ''}.txt`).has(value ?? ''),
        `"${String(value)}" does not belong to "${String(key)}"`,
      ).toBe(true);
    }
  });

  it('parent list and child filenames are the same set', () => {
    const keys = valuesOf(`${parent.replace('.', '/')}.txt`);
    const files = new Set(readdirSync(join(trDir, dir)).map((f) => f.replace(/\.txt$/, '')));
    expect([...keys].filter((k) => !files.has(k))).toEqual([]);
    expect([...files].filter((f) => !keys.has(f))).toEqual([]);
  });
});

describe('tr dates', () => {
  it('render Turkish month and weekday names', () => {
    const months = valuesOf('date/month.txt');
    for (const v of render('tr.date.month', 24)) expect(months.has(v), v).toBe(true);
    expect(months.has('Ocak')).toBe(true);
  });

  /**
   * The DateLocale and the pack list have to agree. The pack list is what a
   * template draws; the DateLocale is what a formatted date prints. Turkish
   * month names do not inflect, so unlike Russian or Polish the two lists are
   * the same twelve words — and if they ever stop being, this fails.
   */
  it('format a date with the same month names the pack lists', () => {
    const cfg =
      '<tdc><env count="12" seed="ay" local="tr">' +
      '<sequence name="D"><gen type="date" from="2026-01-15" to="2026-12-15" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const months = valuesOf('date/month.txt');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const month = row.split(' ')[1];
      expect(months.has(month ?? ''), `"${String(month)}" is not in date/month.txt`).toBe(true);
    }
  });
});
