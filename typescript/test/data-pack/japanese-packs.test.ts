import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Japanese (`ja`) locale pack — the first in this repository written in a
 * script with no alphabet and no spaces.
 *
 * Japanese uses three writing systems at once: kanji for content words,
 * hiragana for grammar and for many girls' given names, katakana for loanwords.
 * A pack written only in kanji would look Japanese to someone who does not read
 * it and be obviously wrong to someone who does, so all three are asserted.
 *
 * The absence of spaces is not cosmetic either — it is why text/word.txt is
 * handwritten while the sentences beside it come from a public-domain corpus.
 * There is nothing to split a Japanese sentence on.
 */

const here = dirname(fileURLToPath(import.meta.url));
const jaDir = resolve(here, '../../../data/packs/ja');

function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(jaDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(
    lines
      .slice(end + 1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/,\d+$/, '')),
  );
}

function render(address: string, count = 40, seed = 'ja'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="ja">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function everyListFile(dir = jaDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...everyListFile(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.txt')) out.push(rel);
  }
  return out;
}

const KANJI = /[一-鿿]/u;
const HIRAGANA = /[぀-ゟ]/u;
const KATAKANA = /[゠-ヿ]/u;

describe('ja uses all three Japanese scripts', () => {
  it('writes kanji, hiragana and katakana', () => {
    const text = everyListFile()
      .map((f) => readFileSync(join(jaDir, f), 'utf8'))
      .join('\n');
    expect(KANJI.test(text), 'no kanji anywhere in the pack').toBe(true);
    expect(HIRAGANA.test(text), 'no hiragana anywhere in the pack').toBe(true);
    expect(KATAKANA.test(text), 'no katakana anywhere in the pack').toBe(true);
  });

  /**
   * Loanwords go in katakana, and Japanese has a great many of them. A pack
   * that translated every borrowed term into kanji would read as archaic or
   * invented — コンピュータ is the word, not 計算機.
   */
  it('writes borrowed product and tech words in katakana', () => {
    for (const file of ['commerce/productNoun.txt', 'hacker/noun.txt', 'music/instrument.txt']) {
      const katakana = [...valuesOf(file)].filter((v) => KATAKANA.test(v)).length;
      expect(katakana, `${file} has no katakana at all`).toBeGreaterThan(5);
    }
  });

  it('gives girls hiragana given names, which the boys list does not have', () => {
    const female = [...valuesOf('person/female/firstName.txt')];
    const hiraganaNames = female.filter((n) => HIRAGANA.test(n));
    expect(hiraganaNames.length, 'no hiragana given names in the female list').toBeGreaterThan(5);
  });
});

describe('ja text has no spaces, which is why word.txt is handwritten', () => {
  /**
   * The structural fact behind the pipeline decision. Japanese sentences carry
   * no word boundaries, so build-text-corpus.mjs refuses to derive a word list
   * and says so; left to itself it returned whole clauses as "words".
   */
  it('has sentences with no spaces in them', () => {
    const sentences = [...valuesOf('text/sentence.txt')];
    expect(sentences.length).toBeGreaterThan(100);
    const withSpaces = sentences.filter((s) => /\s/.test(s));
    expect(withSpaces.length, `${String(withSpaces.length)} sentences contain a space`).toBe(0);
  });

  it('ends sentences with the Japanese full stop', () => {
    for (const s of [...valuesOf('text/sentence.txt')].slice(0, 200)) {
      expect(/[。！？]$/u.test(s), `"${s}" does not end in 。`).toBe(true);
    }
  });

  it('says in its own description that the word list is not derived', () => {
    const header = readFileSync(join(jaDir, 'text/word.txt'), 'utf8').split('---')[1] ?? '';
    expect(header).toContain('Handwritten');
    expect(header).toContain('morphological analyser');
  });
});

describe('ja.person', () => {
  it('draws surnames from the Japanese list', () => {
    const surnames = valuesOf('person/lastName.txt');
    for (const v of render('ja.person.lastName', 60)) expect(surnames.has(v), v).toBe(true);
  });

  /** Family name first: 山田 太郎 is Mr Yamada. */
  it('composes a full name as family + given', () => {
    const cfg = [
      '<tdc><env count="30" seed="namae" local="ja">',
      '  <sequence name="Sei"><gen type="template" value="ja.person.lastName"/></sequence>',
      '  <sequence name="Mei"><gen type="template" value="ja.person.male.firstName"/></sequence>',
      '</env><block><line><data>${{Sei}} ${{Mei}}</data></line></block></tdc>',
    ].join('\n');
    const surnames = valuesOf('person/lastName.txt');
    const givens = valuesOf('person/male/firstName.txt');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [family, given] = row.split(' ');
      expect(surnames.has(family ?? ''), `"${String(family)}" is not a family name`).toBe(true);
      expect(givens.has(given ?? ''), `"${String(given)}" is not a given name`).toBe(true);
    }
  });

  it('declares weighted: true on the lists that carry a count', () => {
    for (const file of [
      'person/lastName.txt',
      'person/male/firstName.txt',
      'person/female/firstName.txt',
    ]) {
      const text = readFileSync(join(jaDir, file), 'utf8');
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

describe.each(COHERENT)('ja coherent %s', (parent, child, dir) => {
  it('every child value belongs to the parent drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="pair" local="ja">',
      `  <sequence name="A"><gen type="template" value="ja.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="ja.${child}.\${{A}}"/></sequence>`,
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
    const files = new Set(readdirSync(join(jaDir, dir)).map((f) => f.replace(/\.txt$/, '')));
    expect([...keys].filter((k) => !files.has(k))).toEqual([]);
    expect([...files].filter((f) => !keys.has(f))).toEqual([]);
  });
});

describe('ja dates', () => {
  it('render a full date as YYYY年M月D日', () => {
    const cfg =
      '<tdc><env count="1" seed="hi" local="ja">' +
      '<sequence name="D"><gen type="date" from="2026-10-09" to="2026-10-09" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    expect(new TDC({ configString: cfg }).toString().trim()).toBe('2026年10月9日');
  });

  /**
   * The seven weekdays are named after the sun, the moon and the five classical
   * elements, and the abbreviation is that element character alone. Both lists
   * have to stay in that order or a date renders the wrong day.
   */
  it('names weekdays after the sun, moon and five elements', () => {
    expect([...valuesOf('date/weekday.txt')]).toEqual([
      '日曜日',
      '月曜日',
      '火曜日',
      '水曜日',
      '木曜日',
      '金曜日',
      '土曜日',
    ]);
    expect([...valuesOf('date/weekdayAbbr.txt')]).toEqual([
      '日',
      '月',
      '火',
      '水',
      '木',
      '金',
      '土',
    ]);
  });

  it('names months by number, as Japanese does', () => {
    expect([...valuesOf('date/month.txt')]).toEqual([
      '1月',
      '2月',
      '3月',
      '4月',
      '5月',
      '6月',
      '7月',
      '8月',
      '9月',
      '10月',
      '11月',
      '12月',
    ]);
  });
});

describe('ja measures that differ from Europe', () => {
  /**
   * Japan sizes shoes in centimetres of foot length, not on the European scale.
   * A Japanese label reads 24.5 and means 24.5 cm; copying the EU numbers into
   * this file would give a country whose shoes are all size 40.
   */
  it('sizes shoes in centimetres, not on the EU scale', () => {
    for (const v of valuesOf('clothing/shoeSizeEu.txt')) {
      const cm = Number(v);
      expect(Number.isFinite(cm), v).toBe(true);
      expect(cm, `${v} looks like a European size, not a foot length in cm`).toBeGreaterThan(20);
      expect(cm, `${v} looks like a European size, not a foot length in cm`).toBeLessThan(32);
    }
  });
});
