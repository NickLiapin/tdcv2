import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Indonesian (`id`) locale pack.
 *
 * Indonesian is written in the plain Latin alphabet with no diacritics at all —
 * no accents, no cedillas, nothing. That makes it the one locale where a stray
 * accented character is unambiguous evidence that a value was copied from
 * another language rather than written in this one, so the pack is checked for
 * exactly that.
 *
 * The other thing worth pinning is that Indonesian names do not inflect for
 * gender, so there is a single surname list. And a large share of Indonesians
 * carry no family name at all — a fact the pack states in its own description
 * rather than pretending a two-part name is universal.
 */

const here = dirname(fileURLToPath(import.meta.url));
const idDir = resolve(here, '../../../data/packs/id');

/** Values of a pack list file, past the fence, with any weight column stripped. */
function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(idDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(
    lines
      .slice(end + 1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/,\d+$/, '')),
  );
}

function render(address: string, count = 40, seed = 'id'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="id">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function everyListFile(dir = idDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...everyListFile(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.txt')) out.push(rel);
  }
  return out;
}

describe('id is written in plain Latin letters', () => {
  /**
   * Indonesian orthography has no diacritics. Any accented letter in a list of
   * Indonesian words came from somewhere else — a Dutch, Spanish or Turkish
   * value left behind, which is exactly the kind of thing a file count cannot
   * see. Loanword lists (brands, drug names, foreign dishes) are excluded, since
   * those legitimately keep their spelling.
   */
  it('has no accented letters in the lists that are Indonesian vocabulary', () => {
    const indonesianOnly = [
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
      'text/word.txt',
    ];
    for (const file of indonesianOnly) {
      for (const value of valuesOf(file)) {
        expect(
          /[àáâãäåçèéêëìíîïñòóôõöùúûüýÿšžğışœæ]/i.test(value),
          `${file}: "${value}" carries a diacritic, which Indonesian does not use`,
        ).toBe(false);
      }
    }
  });

  it('uses the hyphenated reduplication Indonesian forms plurals with', () => {
    const text = everyListFile()
      .map((f) => readFileSync(join(idDir, f), 'utf8'))
      .join('\n');
    // anak-anak, jalan-jalan, kupu-kupu — a language-specific shape that a
    // word-for-word translation from English would not produce.
    expect(/\b(\p{L}{3,})-\1\b/u.test(text)).toBe(true);
  });
});

describe('id.person', () => {
  it('draws surnames from the Indonesian list', () => {
    const surnames = valuesOf('person/lastName.txt');
    for (const v of render('id.person.lastName', 40)) expect(surnames.has(v), v).toBe(true);
  });

  it('gives male and female rows their own given-name lists', () => {
    const male = valuesOf('person/male/firstName.txt');
    const female = valuesOf('person/female/firstName.txt');
    for (const v of render('id.person.male.firstName', 30)) expect(male.has(v), v).toBe(true);
    for (const v of render('id.person.female.firstName', 30)) expect(female.has(v), v).toBe(true);
    expect([...male].filter((n) => female.has(n))).toHaveLength(0);
  });

  /**
   * One surname list for both genders, because Indonesian names do not inflect.
   * Asserted as an absence so that adding a female list later fails loudly
   * rather than silently splitting the family in two.
   */
  it('has no separate female surname list', () => {
    expect(everyListFile().includes('person/female/lastName.txt')).toBe(false);
  });

  it('declares weighted: true on the lists that carry a count', () => {
    for (const file of [
      'person/lastName.txt',
      'person/male/firstName.txt',
      'person/female/firstName.txt',
    ]) {
      const text = readFileSync(join(idDir, file), 'utf8');
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

describe.each(COHERENT)('id coherent %s', (parent, child, dir) => {
  it('every child value belongs to the parent drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="pair" local="id">',
      `  <sequence name="A"><gen type="template" value="id.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="id.${child}.\${{A}}"/></sequence>`,
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
    const files = new Set(readdirSync(join(idDir, dir)).map((f) => f.replace(/\.txt$/, '')));
    expect([...keys].filter((k) => !files.has(k))).toEqual([]);
    expect([...files].filter((f) => !keys.has(f))).toEqual([]);
  });
});

describe('id dates', () => {
  it('render Indonesian month names, and the DateLocale agrees with the pack list', () => {
    const months = valuesOf('date/month.txt');
    for (const v of render('id.date.month', 24)) expect(months.has(v), v).toBe(true);
    expect(months.has('Januari')).toBe(true);

    const cfg =
      '<tdc><env count="12" seed="bulan" local="id">' +
      '<sequence name="D"><gen type="date" from="2026-01-15" to="2026-12-15" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const month = row.split(' ')[1];
      expect(months.has(month ?? ''), `"${String(month)}" is not in date/month.txt`).toBe(true);
    }
  });

  /**
   * Indonesia sits on the equator and has two seasons, not four. The pack lists
   * both — the two real ones first — because a config writing about Europe in
   * Indonesian still needs the four-season words.
   */
  it('lists the two equatorial seasons first', () => {
    const seasons = [...valuesOf('date/season.txt')];
    expect(seasons.slice(0, 2)).toEqual(['musim hujan', 'musim kemarau']);
  });
});
