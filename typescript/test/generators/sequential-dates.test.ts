/**
 * `<gen type="date" order="sequential">` — a date range walked instead of drawn.
 *
 * Before this there was no way to put a time axis under a run. A date range drew
 * at random, so "one row per day for a year" came out with repeats and gaps;
 * `order="sequential"` was refused on a date (TDC015) and `uniq="true"` could not
 * enumerate one. The only method that worked was a 365-line file read with
 * `<gen type="file" order="sequential">` — two parties reached that workaround
 * independently, which is the usual sign of a missing primitive.
 *
 * ── Why this spelling ────────────────────────────────────────────────────────
 * `order="sequential"` already means "read by position rather than draw", and it
 * already owns the answers to the two questions a walked range raises: what
 * happens past the end (loop) and how to refuse instead (`cycle="false"`). A
 * separate `from=`/`step=` form would have been a second way to say where a
 * range starts, inheriting none of that.
 *
 * ── What these tests are for ─────────────────────────────────────────────────
 * The step is computed from the START each time — `start + n × step` — never
 * accumulated. That distinction is invisible on `day` and decides the answer on
 * `month`: from 31 January, two months on is 31 March, not the 28 March that
 * stepping through a clamped February would give. Both are tested, because only
 * the second one can tell the implementations apart.
 */

import { describe, expect, it } from 'vitest';

import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

const config = (count: number, gen: string): string =>
  `<tdc><env count="${String(count)}" seed="sd" local="en">` +
  `<sequence name="D">${gen}</sequence>` +
  `</env><block><line><data>\${{D}}</data></line></block></tdc>`;

const rows = (doc: string, opts: RenderOptions): string[] =>
  render(parseStrict(doc), opts).split('\n').filter(Boolean);

const DAY = config(
  5,
  '<gen type="date" range="2026-01-01..2026-01-05" order="sequential" format="YYYY-MM-DD"/>',
);

describe('a date range walked by step', () => {
  for (const [label, opts] of ENGINES) {
    it(`walks the range one day at a time (${label})`, () => {
      expect(rows(DAY, opts)).toEqual([
        '2026-01-01',
        '2026-01-02',
        '2026-01-03',
        '2026-01-04',
        '2026-01-05',
      ]);
    });

    it(`loops back to the start past the end, like a text list does (${label})`, () => {
      const doc = config(
        7,
        '<gen type="date" range="2026-01-01..2026-01-03" order="sequential" format="YYYY-MM-DD"/>',
      );
      expect(rows(doc, opts)).toEqual([
        '2026-01-01',
        '2026-01-02',
        '2026-01-03',
        '2026-01-01',
        '2026-01-02',
        '2026-01-03',
        '2026-01-01',
      ]);
    });

    it(`measures each step from the START, so a clamped month does not drift (${label})`, () => {
      // 31 Jan + 1 month clamps to 28 Feb; + 2 months is 31 March, NOT the 28
      // March that stepping on from the clamped February would give.
      const doc = config(
        4,
        '<gen type="date" range="2026-01-31..2026-12-31" order="sequential" step="month" format="YYYY-MM-DD"/>',
      );
      expect(rows(doc, opts)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    });

    it(`steps by hour when asked (${label})`, () => {
      const doc = config(
        3,
        '<gen type="date" range="2026-01-01T00:00:00..2026-01-01T05:00:00" order="sequential" step="hour" format="YYYY-MM-DD HH:mm"/>',
      );
      expect(rows(doc, opts)).toEqual(['2026-01-01 00:00', '2026-01-01 01:00', '2026-01-01 02:00']);
    });

    it(`refuses to loop when cycle="false" (${label})`, () => {
      const doc = config(
        4,
        '<gen type="date" range="2026-01-01..2026-01-02" order="sequential" cycle="false" format="YYYY-MM-DD"/>',
      );
      expect(() => rows(doc, opts)).toThrow(/only 2 values/);
    });
  }

  it('gives the same rows on all three engines', () => {
    const [memory, stream, disk] = ENGINES.map(([, opts]) => rows(DAY, opts));
    expect(stream).toEqual(memory);
    expect(disk).toEqual(memory);
  });

  it('leaps a leap day rather than skipping it', () => {
    const doc = config(
      3,
      '<gen type="date" range="2024-02-28..2024-03-01" order="sequential" format="YYYY-MM-DD"/>',
    );
    expect(rows(doc, ENGINES[0]![1])).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
  });
});

describe('what the validator says about a walked date', () => {
  const codesOf = (gen: string): string[] => {
    const parsed = parse(config(3, gen));
    expect(parsed.diagnostics).toEqual([]);
    return validate(parsed.tree).diagnostics.map((d) => d.code);
  };

  it('accepts order and step on a date', () => {
    expect(
      codesOf('<gen type="date" range="2026-01-01..2026-12-31" order="sequential" step="day"/>'),
    ).toEqual([]);
  });

  it('refuses a step unit it cannot walk', () => {
    expect(
      codesOf(
        '<gen type="date" range="2026-01-01..2026-12-31" order="sequential" step="fortnight"/>',
      ),
    ).toContain('TDC247');
  });

  it('refuses step= without order="sequential" — nothing would read it', () => {
    expect(codesOf('<gen type="date" range="2026-01-01..2026-12-31" step="day"/>')).toContain(
      'TDC248',
    );
  });
});
