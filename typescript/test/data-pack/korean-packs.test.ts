import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Korean (`ko`) locale pack.
 *
 * Korean is written in hangul, an alphabet designed and promulgated in 1443 —
 * one of the few writing systems with a known author and date. Modern Korean
 * uses hanja (Chinese characters) only in rare specialist contexts, so a pack
 * sprinkled with hanja would read as either archaic or as Japanese leaking in.
 *
 * The surname distribution is the sharpest of any locale here: 김, 이 and 박
 * together are roughly 45% of the country. As with Vietnamese, that is encoded
 * as measured census shares rather than a decay curve, and the test draws a
 * large sample and counts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const koDir = resolve(here, '../../../data/packs/ko');

function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(koDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(
    lines
      .slice(end + 1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/,\d+$/, '')),
  );
}

function render(address: string, count = 40, seed = 'ko'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="ko">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function everyListFile(dir = koDir, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...everyListFile(join(dir, entry.name), rel));
    else if (entry.name.endsWith('.txt')) out.push(rel);
  }
  return out;
}

const HANGUL = /[가-힣]/u;
const HANJA = /[一-鿿]/u;
const KANA = /[぀-ヿ]/u;

describe('ko is written in hangul', () => {
  it('uses hangul throughout', () => {
    const text = everyListFile()
      .map((f) => readFileSync(join(koDir, f), 'utf8'))
      .join('\n');
    expect(HANGUL.test(text), 'no hangul anywhere in the pack').toBe(true);
  });

  /**
   * Modern Korean writes hanja only in rare specialist contexts, and never
   * kana at all. Either appearing in a list of ordinary Korean vocabulary means
   * a value was copied from the Chinese or Japanese pack and never translated —
   * which is easy to do and impossible to see at a glance.
   */
  it('has no hanja and no kana in the lists that are Korean vocabulary', () => {
    const koreanOnly = [
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
      'text/word.txt',
      'medical/diagnosis.txt',
    ];
    for (const file of koreanOnly) {
      for (const value of valuesOf(file)) {
        expect(HANJA.test(value), `${file}: "${value}" contains hanja`).toBe(false);
        expect(KANA.test(value), `${file}: "${value}" contains Japanese kana`).toBe(false);
      }
    }
  });
});

describe('ko surnames are the most concentrated of any locale here', () => {
  /**
   * 김 alone is about a fifth of South Korea. On the generic rank curve it would
   * come out near 2%, and a generated dataset would quietly claim Korean
   * surnames are evenly spread. Counting a large sample is the only way to see
   * the difference.
   */
  it('draws 김 for roughly a fifth of rows', () => {
    const rows = render('ko.person.lastName', 2000, 'bunpo');
    const share = rows.filter((v) => v === '김').length / rows.length;
    expect(share, `김 came out at ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.15);
    expect(share, `김 came out at ${(share * 100).toFixed(1)}%`).toBeLessThan(0.32);
  });

  it('gives 김, 이 and 박 together close to half the rows', () => {
    const bigThree = new Set(['김', '이', '박']);
    const rows = render('ko.person.lastName', 2000, 'bunpo');
    const share = rows.filter((v) => bigThree.has(v)).length / rows.length;
    expect(share, `the big three came out at ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.35);
  });

  it('draws every value from the surname list', () => {
    const surnames = valuesOf('person/lastName.txt');
    for (const v of render('ko.person.lastName', 200)) expect(surnames.has(v), v).toBe(true);
  });

  it('declares weighted: true on the lists that carry a count', () => {
    for (const file of [
      'person/lastName.txt',
      'person/male/firstName.txt',
      'person/female/firstName.txt',
    ]) {
      const text = readFileSync(join(koDir, file), 'utf8');
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

describe.each(COHERENT)('ko coherent %s', (parent, child, dir) => {
  it('every child value belongs to the parent drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="pair" local="ko">',
      `  <sequence name="A"><gen type="template" value="ko.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="ko.${child}.\${{A}}"/></sequence>`,
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
    const files = new Set(readdirSync(join(koDir, dir)).map((f) => f.replace(/\.txt$/, '')));
    expect([...keys].filter((k) => !files.has(k))).toEqual([]);
    expect([...files].filter((f) => !keys.has(f))).toEqual([]);
  });
});

describe('ko dates', () => {
  it('render a full date as YYYY년 M월 D일', () => {
    const cfg =
      '<tdc><env count="1" seed="nal" local="ko">' +
      '<sequence name="D"><gen type="date" from="2026-10-09" to="2026-10-09" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    expect(new TDC({ configString: cfg }).toString().trim()).toBe('2026년 10월 9일');
  });

  /**
   * Korean and Japanese name the weekdays with the same seven elements — sun,
   * moon, fire, water, wood, metal, earth — because both took the system from
   * Chinese. Same order, different script, which is why both packs pin it.
   */
  it('names weekdays after the sun, moon and five elements', () => {
    expect([...valuesOf('date/weekday.txt')]).toEqual([
      '일요일',
      '월요일',
      '화요일',
      '수요일',
      '목요일',
      '금요일',
      '토요일',
    ]);
    expect([...valuesOf('date/weekdayAbbr.txt')]).toEqual([
      '일',
      '월',
      '화',
      '수',
      '목',
      '금',
      '토',
    ]);
  });
});

describe('ko measures that differ from Europe', () => {
  /**
   * Korea sizes shoes in millimetres of foot length, Japan in centimetres, and
   * Europe on a scale of its own. Copying the EU numbers here would give a
   * country whose shoes are all 40 mm long.
   */
  it('sizes shoes in millimetres, not on the EU scale', () => {
    for (const v of valuesOf('clothing/shoeSizeEu.txt')) {
      const mm = Number(v);
      expect(Number.isFinite(mm), v).toBe(true);
      expect(mm, `${v} looks like a European size, not a foot length in mm`).toBeGreaterThan(200);
      expect(mm, `${v} looks like a European size, not a foot length in mm`).toBeLessThan(320);
    }
  });
});
