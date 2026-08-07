/**
 * `<gen type="date" of="In" plus="3..10d">` — a date measured from another date.
 *
 * The tests below are built so an implementation cannot pass by accident. The
 * source window is January–March 2026, which crosses a month boundary and a
 * 28-day February, so an offset that adds days by arithmetic on the day NUMBER
 * rather than on the calendar shows up immediately.
 *
 * The heart of it is the format question. A date column renders its value —
 * `02/03/2026` in an en locale, `03.02.2026` in a ru one — and the two spellings
 * mean different days. So the offset does not read the text at all when the
 * source is a date TDC generated: that column keeps the instant behind its cell
 * and the arithmetic runs on the value. `MMMM D`, which throws the year away
 * entirely, is the case that proves it — no reader of the text could recover
 * March 2027 from "March 2".
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TDC } from '../../src/lib/tdc.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** One column of `In -> Out` rows. */
function rows(source: string, offset: string, count = 6, locale = 'en'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="s1" local="${locale}">` +
    `<sequence name="In"><gen type="date" ${source}/></sequence>` +
    `<sequence name="Out"><gen type="date" of="In" ${offset}/></sequence>` +
    '</env><block><line><data>${{In}}|${{Out}}</data></line></block></tdc>';
  return new TDC({ configString: config, now: NOW })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

/** Both cells of a row, as ISO dates. */
function pair(line: string): [string, string] {
  const [a, b] = line.split('|');
  return [a ?? '', b ?? ''];
}

/** Whole days between two ISO dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

const WINDOW = 'from="2026-01-01" to="2026-03-01" format="YYYY-MM-DD"';

describe('date offset — the interval', () => {
  it('lands inside the range on every row, and never before the source', () => {
    for (const line of rows(WINDOW, 'plus="3..10d" format="YYYY-MM-DD"', 40)) {
      const [from, to] = pair(line);
      const gap = daysBetween(from, to);
      expect(gap).toBeGreaterThanOrEqual(3);
      expect(gap).toBeLessThanOrEqual(10);
    }
  });

  it('a fixed offset is exactly that distance, every row', () => {
    for (const line of rows(WINDOW, 'plus="7d" format="YYYY-MM-DD"', 20)) {
      const [from, to] = pair(line);
      expect(daysBetween(from, to)).toBe(7);
    }
  });

  it('a range actually varies — a fixed reading of it would collapse to one gap', () => {
    const gaps = new Set(
      rows(WINDOW, 'plus="1..30d" format="YYYY-MM-DD"', 40).map((line) => {
        const [from, to] = pair(line);
        return daysBetween(from, to);
      }),
    );
    expect(gaps.size).toBeGreaterThan(5);
  });

  it('counts backwards when the offset is negative', () => {
    for (const line of rows(WINDOW, 'plus="-5..-1d" format="YYYY-MM-DD"', 20)) {
      const [from, to] = pair(line);
      const gap = daysBetween(from, to);
      expect(gap).toBeGreaterThanOrEqual(-5);
      expect(gap).toBeLessThanOrEqual(-1);
    }
  });

  it('months move by the calendar, not by 30 days', () => {
    // 2026-01-31 + 1mo is the end of February, which has 28 days in 2026.
    const line = rows(
      'value="2026-01-31" format="YYYY-MM-DD"',
      'plus="1mo" format="YYYY-MM-DD"',
      1,
    );
    expect(pair(line[0] ?? '')[1]).toBe('2026-02-28');
  });
});

describe('date offset — the value, not its spelling', () => {
  it('works when the source renders in a format no reader could parse back', () => {
    // `MMMM D` has no year at all. The offset still lands a month later in 2026,
    // which is only possible if it measured from the value behind the text.
    const line = rows('value="2026-01-31" format="MMMM D"', 'plus="1mo" format="YYYY-MM-DD"', 1);
    const [from, to] = pair(line[0] ?? '');
    expect(from).toBe('January 31');
    expect(to).toBe('2026-02-28');
  });

  it('works under a locale whose default format reads the other way round', () => {
    // ru renders `L` as DD.MM.YYYY, en as MM/DD/YYYY — the same eight digits,
    // two different days. Neither is read; both give the same seven-day gap.
    for (const locale of ['en', 'ru']) {
      const line = rows('value="2026-02-03"', 'plus="7d" format="YYYY-MM-DD"', 1, locale);
      expect(pair(line[0] ?? '')[1]).toBe('2026-02-10');
    }
  });

  it('chains: an offset is itself a date the next offset can measure from', () => {
    // Signed, expires a year later, remind a month before that — and every cell
    // rendered in a format nothing could parse back. The chain holds because
    // each link keeps its own value, not because the middle one is re-read.
    const config =
      '<tdc><env count="1" seed="s1" local="en">' +
      '<sequence name="Signed"><gen type="date" value="2026-02-05" format="D MMMM YYYY"/></sequence>' +
      '<sequence name="Expires"><gen type="date" of="Signed" plus="1y" format="D MMMM YYYY"/></sequence>' +
      '<sequence name="Remind"><gen type="date" of="Expires" plus="-30d" format="D MMMM YYYY"/></sequence>' +
      '</env><block><line><data>${{Signed}}|${{Expires}}|${{Remind}}</data></line></block></tdc>';
    const line = new TDC({ configString: config, now: NOW }).toString().trim();
    expect(line).toBe('5 February 2026|5 February 2027|6 January 2027');
  });

  it('measures from a WALKED source — the pairing real records ask for most', () => {
    // Orders march down the calendar and delivery is a few days after its own order. The
    // walked axis returns before the drawn-date branch, so its instants have to be filled
    // there too; without that every row read as "this row has no date" and the column came
    // out empty, in silence, from a config that was right.
    const config =
      '<tdc><env count="4" seed="s" local="en">' +
      '<sequence name="Ordered"><gen type="date" from="2026-01-01" order="sequential" step="1d" format="YYYY-MM-DD"/></sequence>' +
      '<sequence name="Delivered"><gen type="date" of="Ordered" plus="2..9d" format="YYYY-MM-DD"/></sequence>' +
      '</env><block><line><data>${{Ordered}}|${{Delivered}}</data></line></block></tdc>';
    const out = new TDC({ configString: config, now: NOW })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(out).toHaveLength(4);
    for (const line of out) {
      const [from, to] = pair(line);
      expect(to).not.toBe('');
      const gap = daysBetween(from, to);
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(9);
    }
    // And it really walked: consecutive days, not four independent draws.
    expect(out.map((l) => pair(l)[0])).toEqual([
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
  });

  it('a repeating source is refused out loud, not answered with an empty column', () => {
    // A cell holding several dates has no single date to measure from. The honest answer is
    // the refusal by name — silence here is the same defect the walked axis had.
    const config =
      '<tdc><env count="2" seed="s" local="en">' +
      '<sequence name="Visits"><gen type="date" from="2026-01-01" to="2026-03-01" format="YYYY-MM-DD" repeat="2"/></sequence>' +
      '<sequence name="Follow"><gen type="date" of="Visits" plus="7d" format="YYYY-MM-DD"/></sequence>' +
      '</env><block><line><data>${{Follow}}</data></line></block></tdc>';
    expect(() => new TDC({ configString: config, now: NOW }).toString()).toThrow(/is not a date/);
  });

  it('a source cell "missing" blanked measures nothing, rather than a wrong date', () => {
    const out = rows(`${WINDOW} missing="1.0"`, 'plus="7d" format="YYYY-MM-DD"', 5);
    for (const line of out) expect(pair(line)).toEqual(['', '']);
  });
});

describe('date offset — a source TDC did not generate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tdc-offset-'));

  function fromFile(contents: string): string[] {
    const path = join(dir, `${String(contents.length)}.txt`);
    writeFileSync(path, contents);
    const config =
      '<tdc><env count="3" seed="s1" local="en">' +
      `<sequence name="In"><gen type="file" src="${path}"/></sequence>` +
      '<sequence name="Out"><gen type="date" of="In" plus="5d" format="YYYY-MM-DD"/></sequence>' +
      '</env><block><line><data>${{In}}|${{Out}}</data></line></block></tdc>';
    return new TDC({ configString: config, now: NOW })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
  }

  it('reads ISO text, which means one thing in every locale', () => {
    for (const line of fromFile('2026-01-05\n2026-02-11\n2026-03-20\n')) {
      const [from, to] = pair(line);
      expect(daysBetween(from, to)).toBe(5);
    }
  });

  it('refuses an ambiguous spelling instead of guessing which half is the month', () => {
    expect(() => fromFile('02/03/2026\n05/06/2026\n07/08/2026\n')).toThrow(/is not a date/);
  });
});
