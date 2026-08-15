import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Vietnamese (`vi`) locale pack.
 *
 * Almost everything the other locales assume about names is wrong here, so this
 * file mostly checks the ways Vietnamese differs:
 *
 *   * the family name comes FIRST. Nguyễn Văn An is Mr Nguyễn, not Mr An.
 *   * given names are largely UNISEX. The male and female lists are supposed to
 *     overlap — the opposite of what the Turkish and Indonesian tests assert.
 *     Gender is carried by the MIDDLE name: Văn for men, Thị for women.
 *   * surnames are extraordinarily concentrated. Nguyễn alone is roughly 38% of
 *     the population, so the weights are real proportions rather than the gentle
 *     rank curve every other locale uses. A flat list would misrepresent the
 *     country, and the only way to catch that is to draw a large sample and
 *     count — which is what the test below does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const viDir = resolve(here, '../../../data/packs/vi');

function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(viDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(
    lines
      .slice(end + 1)
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/,\d+$/, '')),
  );
}

function render(address: string, count = 40, seed = 'vi'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="vi">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('vi surnames are concentrated, and the weights say so', () => {
  /**
   * The single most important statistical fact about Vietnamese names. If the
   * weight column were the usual rank^-0.1 curve, Nguyễn would come out at
   * around 2% of rows instead of a third of them, and every generated dataset
   * would quietly claim Vietnam has evenly spread surnames. Drawing 2000 rows
   * and counting is the only way to see it.
   */
  it('draws Nguyễn for roughly a third of rows', () => {
    const rows = render('vi.person.lastName', 2000, 'phanphoi');
    const nguyen = rows.filter((v) => v === 'Nguyễn').length;
    const share = nguyen / rows.length;
    expect(share, `Nguyễn came out at ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.25);
    expect(share, `Nguyễn came out at ${(share * 100).toFixed(1)}%`).toBeLessThan(0.5);
  });

  it('gives the top handful of surnames the clear majority of rows', () => {
    const top = new Set(['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ']);
    const rows = render('vi.person.lastName', 2000, 'phanphoi');
    const share = rows.filter((v) => top.has(v)).length / rows.length;
    expect(share, `the top nine came out at ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.7);
  });

  it('draws every value from the surname list', () => {
    const surnames = valuesOf('person/lastName.txt');
    for (const v of render('vi.person.lastName', 200)) expect(surnames.has(v), v).toBe(true);
  });
});

describe('vi given names are unisex', () => {
  /**
   * The inverse of the Turkish and Indonesian assertions. Anh, Minh, Ngọc,
   * Thanh and Xuân are carried by men and women alike, so an overlap between
   * the two lists is CORRECT. If someone "fixes" the overlap away later, this
   * fails and says why.
   */
  it('has male and female lists that deliberately overlap', () => {
    const male = valuesOf('person/male/firstName.txt');
    const female = valuesOf('person/female/firstName.txt');
    const shared = [...male].filter((n) => female.has(n));
    expect(
      shared.length,
      'the two lists share no name, but Vietnamese given names are largely unisex',
    ).toBeGreaterThan(15);
  });

  it('carries the middle name that actually marks gender', () => {
    expect(valuesOf('person/male/middleName.txt').has('Văn')).toBe(true);
    expect(valuesOf('person/female/middleName.txt').has('Thị')).toBe(true);
    for (const v of render('vi.person.male.middleName', 30)) {
      expect(valuesOf('person/male/middleName.txt').has(v), v).toBe(true);
    }
  });

  /**
   * Family name first, then middle, then given — the order a Vietnamese full
   * name is written in. Composed here so the pack's own parts are checked in
   * the arrangement a config would actually use them in.
   */
  it('composes a full name as family + middle + given', () => {
    const cfg = [
      '<tdc><env count="30" seed="hoten" local="vi">',
      '  <sequence name="Ho"><gen type="template" value="vi.person.lastName"/></sequence>',
      '  <sequence name="Dem"><gen type="template" value="vi.person.female.middleName"/></sequence>',
      '  <sequence name="Ten"><gen type="template" value="vi.person.female.firstName"/></sequence>',
      '</env><block><line><data>${{Ho}} ${{Dem}} ${{Ten}}</data></line></block></tdc>',
    ].join('\n');
    const surnames = valuesOf('person/lastName.txt');
    const middles = valuesOf('person/female/middleName.txt');
    const givens = valuesOf('person/female/firstName.txt');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const parts = row.split(' ');
      expect(parts.length, row).toBe(3);
      expect(surnames.has(parts[0] ?? ''), `"${String(parts[0])}" is not a family name`).toBe(true);
      expect(middles.has(parts[1] ?? ''), `"${String(parts[1])}" is not a middle name`).toBe(true);
      expect(givens.has(parts[2] ?? ''), `"${String(parts[2])}" is not a given name`).toBe(true);
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

describe.each(COHERENT)('vi coherent %s', (parent, child, dir) => {
  it('every child value belongs to the parent drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="cap" local="vi">',
      `  <sequence name="A"><gen type="template" value="vi.${parent}"/></sequence>`,
      `  <sequence name="B" parent="A"><gen type="template" value="vi.${child}.\${{A}}"/></sequence>`,
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
    const files = new Set(readdirSync(join(viDir, dir)).map((f) => f.replace(/\.txt$/, '')));
    expect([...keys].filter((k) => !files.has(k))).toEqual([]);
    expect([...files].filter((f) => !keys.has(f))).toEqual([]);
  });
});

describe('vi dates', () => {
  /**
   * Vietnamese has no month words of its own — a month is "tháng" plus its
   * number — and a written date needs "ngày" and "năm" around it. The format
   * strings carry those as bracketed literals, so this checks the literals
   * actually survive into the output rather than being swallowed as tokens.
   */
  it('render a full date as ngày D tháng M năm YYYY', () => {
    const cfg =
      '<tdc><env count="5" seed="ngay" local="vi">' +
      '<sequence name="D"><gen type="date" from="2026-10-09" to="2026-10-09" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const rows = new TDC({ configString: cfg }).toString().trim().split('\n');
    expect(rows[0]).toBe('ngày 9 tháng 10 năm 2026');
  });

  it('lists months as tháng plus a number, matching the DateLocale', () => {
    const months = valuesOf('date/month.txt');
    expect(months.has('tháng 10')).toBe(true);
    for (const v of render('vi.date.month', 24)) expect(months.has(v), v).toBe(true);
  });

  /** Sunday is the one weekday with a name; the rest are counted from two. */
  it('counts weekdays, with Sunday as the exception', () => {
    const days = [...valuesOf('date/weekday.txt')];
    expect(days[0]).toBe('Chủ Nhật');
    expect(days[1]).toBe('Thứ Hai');
  });
});
