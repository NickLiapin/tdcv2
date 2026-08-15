import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Ukrainian locale pack (data/packs/uk). Ukrainian shares the Cyrillic
 * alphabet with Russian and is routinely mistaken for it, so the checks here are
 * mostly about the pack being Ukrainian rather than merely Cyrillic: the four
 * letters Russian does not have, a surname list that is genuinely Ukrainian in
 * shape, and the five coherent parent->child groups whose keys are Ukrainian
 * words and therefore easy to get out of step with their filenames.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ukDir = resolve(here, '../../../data/packs/uk');

/**
 * Values of a pack list file, past the `--- … ---` frontmatter fence.
 *
 * The person lists are weighted (`weighted: true`), so each line is
 * `value,count` and the engine hands back only the value. Comparing the raw
 * line against a rendered value would fail on every weighted file — and, worse,
 * would PASS if the pack ever lost its `weighted: true` header, because then
 * both sides would carry the count. Strip the trailing count here so the test
 * sees what a config sees.
 */
function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(ukDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(
    lines
      .slice(end + 1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/,\d+$/, '')),
  );
}

function render(address: string, count = 40, seed = 'uk'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="uk">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

/** Every list file in the pack, as pack-relative paths. */
function everyListFile(dir = ukDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...everyListFile(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.txt')) out.push(rel);
  }
  return out;
}

describe('uk is Ukrainian, not Russian in Cyrillic', () => {
  /**
   * The four letters that exist in Ukrainian and not in Russian. A pack
   * transliterated or copied from ru would be all-Cyrillic and pass any test
   * that only looked for Cyrillic — this one would not pass.
   */
  it('uses і, ї, є and ґ across the pack', () => {
    const text = everyListFile()
      .map((f) => readFileSync(join(ukDir, f), 'utf8'))
      .join('\n');
    for (const letter of ['і', 'ї', 'є', 'ґ']) {
      expect(text.includes(letter), `no "${letter}" anywhere in the pack`).toBe(true);
    }
  });

  /** Russian has ы, э and ъ; Ukrainian has none of the three. */
  it('contains no letter that only Russian has', () => {
    for (const file of everyListFile()) {
      const body = [...valuesOf(file)].join('\n');
      expect(/[ыэъ]/i.test(body), `${file} contains a Russian-only letter`).toBe(false);
    }
  });
});

describe('uk person lists that carry a count', () => {
  /**
   * A `value,count` body is only read as weighted when the header says
   * `weighted: true`. Without it the pack still loads — and quietly serves
   * "Артем,802741" as a given name. Nothing else in the pipeline notices, which
   * is why the header is asserted here rather than left to be discovered.
   */
  it('declare weighted: true, so the count is a weight and not part of the name', () => {
    const weighted = [
      'person/lastName.txt',
      'person/male/lastName.txt',
      'person/female/lastName.txt',
      'person/male/firstName.txt',
      'person/female/firstName.txt',
      'person/male/patronymic.txt',
      'person/female/patronymic.txt',
    ];
    for (const file of weighted) {
      const text = readFileSync(join(ukDir, file), 'utf8');
      expect(text.includes('\nweighted: true\n'), `${file} has a count column but no header`).toBe(
        true,
      );
      for (const line of [...valuesOf(file)]) {
        expect(/,\d+$/.test(line), `${file}: "${line}" still carries its count`).toBe(false);
      }
    }
  });
});

describe('uk.person', () => {
  it('draws surnames from the Ukrainian list', () => {
    const surnames = valuesOf('person/lastName.txt');
    for (const v of render('uk.person.lastName', 40)) expect(surnames.has(v), v).toBe(true);
  });

  it('gives male and female rows their own given-name lists', () => {
    const male = valuesOf('person/male/firstName.txt');
    const female = valuesOf('person/female/firstName.txt');
    for (const v of render('uk.person.male.firstName', 30)) expect(male.has(v), v).toBe(true);
    for (const v of render('uk.person.female.firstName', 30)) expect(female.has(v), v).toBe(true);
    // The two lists are distinct, not one list served twice.
    expect([...male].filter((n) => female.has(n))).toHaveLength(0);
  });

  it('carries a patronymic, as Ukrainian full names do', () => {
    for (const v of render('uk.person.male.patronymic', 20)) {
      expect(v, v).toMatch(/(ович|ич)$/);
    }
    for (const v of render('uk.person.female.patronymic', 20)) {
      expect(v, v).toMatch(/(івна|ївна|ична)$/);
    }
  });
});

/**
 * The five coherent groups. Each is a parent list whose values ARE the
 * filenames of its child directory, which means a typo in either place silently
 * produces an empty draw rather than an error. These tests draw the pair on one
 * row and check the child value really belongs to the parent drawn beside it.
 */
const COHERENT: [string, string, string][] = [
  ['food.cuisine', 'food.dishByCuisine', 'food/dishByCuisine'],
  ['work.industryCoherent', 'work.jobByIndustry', 'work/jobByIndustry'],
  ['medical.specialtyCoherent', 'medical.diagnosisBySpecialty', 'medical/diagnosisBySpecialty'],
  ['medical.ancestry', 'medical.diagnosisByAncestry', 'medical/diagnosisByAncestry'],
  ['sport.sportCoherent', 'sport.positionBySport', 'sport/positionBySport'],
];

describe.each(COHERENT)('uk coherent %s', (parent, child, dir) => {
  it('every child value belongs to the parent drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="pair" local="uk">',
      `  <sequence name="A"><gen type="template" value="uk.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="uk.${child}.\${{A}}"/></sequence>`,
      '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [key, value] = row.split('|');
      expect(key, row).toBeTruthy();
      expect(value, row).toBeTruthy();
      expect(
        valuesOf(`${dir}/${key ?? ''}.txt`).has(value ?? ''),
        `"${String(value)}" does not belong to "${String(key)}"`,
      ).toBe(true);
    }
  });

  it('parent list and child filenames are the same set', () => {
    const keys = valuesOf(`${parent.replace('.', '/')}.txt`);
    const files = new Set(readdirSync(join(ukDir, dir)).map((f) => f.replace(/\.txt$/, '')));
    expect([...keys].filter((k) => !files.has(k))).toEqual([]);
    expect([...files].filter((f) => !keys.has(f))).toEqual([]);
  });
});

describe('uk dates', () => {
  it('render Ukrainian month and weekday names', () => {
    const months = valuesOf('date/month.txt');
    const weekdays = valuesOf('date/weekday.txt');
    for (const v of render('uk.date.month', 24)) expect(months.has(v), v).toBe(true);
    for (const v of render('uk.date.weekday', 24)) expect(weekdays.has(v), v).toBe(true);
    // The Ukrainian calendar keeps its own month names rather than the Latin
    // ones: січень, not "January" in Cyrillic letters.
    expect(months.has('січень') || months.has('Січень')).toBe(true);
  });
});
