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
        '<gen type="date" range="2026-01-31..2026-12-31" order="sequential" step="1mo" format="YYYY-MM-DD"/>',
      );
      expect(rows(doc, opts)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    });

    it(`steps by hour when asked (${label})`, () => {
      const doc = config(
        3,
        '<gen type="date" range="2026-01-01T00:00:00..2026-01-01T05:00:00" order="sequential" step="1h" format="YYYY-MM-DD HH:mm"/>',
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
    return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
  };

  it('accepts order and step on a date', () => {
    expect(
      codesOf('<gen type="date" range="2026-01-01..2026-12-31" order="sequential" step="1d"/>'),
    ).toEqual([]);
  });

  it('refuses a step it cannot walk', () => {
    expect(
      codesOf(
        '<gen type="date" range="2026-01-01..2026-12-31" order="sequential" step="fortnight"/>',
      ),
    ).toContain('TDC247');
  });

  it('refuses step= without order="sequential" — nothing would read it', () => {
    expect(codesOf('<gen type="date" range="2026-01-01..2026-12-31" step="1d"/>')).toContain(
      'TDC248',
    );
  });
});

/**
 * The three things the first design missed, all of them about a run whose LENGTH
 * is the input and whose end is a consequence.
 *
 * Requiring a `to=` meant working out what date the millionth day falls on in
 * order to write it down. The end of a walked axis is `start + count × step`; it
 * is not something a config should have to compute in its author's head.
 */
describe('an open axis, a multiplied step, and a weekday filter', () => {
  it('walks forward from `from=` with no end at all', () => {
    const doc = config(
      4,
      '<gen type="date" from="2026-01-01" order="sequential" format="YYYY-MM-DD"/>',
    );
    for (const [, opts] of ENGINES) {
      expect(rows(doc, opts)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
    }
  });

  it('never loops, because an open axis has no end to loop at', () => {
    // The bounded form wraps at the end of its range. This one cannot: row i is
    // start + i steps, whatever i is, which is the whole point.
    const doc = config(
      400,
      '<gen type="date" from="2026-01-01" order="sequential" format="YYYY-MM-DD"/>',
    );
    const out = rows(doc, ENGINES[0]![1]);
    expect(out[364]).toBe('2026-12-31');
    expect(out[399]).toBe('2027-02-04');
    expect(new Set(out).size).toBe(400);
  });

  it('multiplies the step when asked', () => {
    const doc = config(
      3,
      '<gen type="date" from="2026-01-01T00:00:00" order="sequential" step="15m" format="YYYY-MM-DD HH:mm"/>',
    );
    expect(rows(doc, ENGINES[0]![1])).toEqual([
      '2026-01-01 00:00',
      '2026-01-01 00:15',
      '2026-01-01 00:30',
    ]);
  });

  it('reads a bare number as days, the default unit', () => {
    const doc = config(
      3,
      '<gen type="date" from="2026-01-01" order="sequential" step="2" format="YYYY-MM-DD"/>',
    );
    expect(rows(doc, ENGINES[0]![1])).toEqual(['2026-01-01', '2026-01-03', '2026-01-05']);
  });

  it('keeps only the weekdays `weekdays=` names', () => {
    // 2026-01-01 is a Thursday. mon..fri therefore gives Thu, Fri, then jumps the
    // weekend to Monday — the jump being exactly why this is a filter and not a
    // step: the spacing is no longer even.
    const doc = config(
      4,
      '<gen type="date" from="2026-01-01" order="sequential" weekdays="mon..fri" format="YYYY-MM-DD"/>',
    );
    for (const [, opts] of ENGINES) {
      expect(rows(doc, opts)).toEqual(['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06']);
    }
  });

  it('takes a list of days as well as a span', () => {
    const doc = config(
      3,
      '<gen type="date" from="2026-01-01" order="sequential" weekdays="sun,wed" format="YYYY-MM-DD"/>',
    );
    expect(rows(doc, ENGINES[0]![1])).toEqual(['2026-01-04', '2026-01-07', '2026-01-11']);
  });

  it('combines the two: every 12 hours, working days only', () => {
    const doc = config(
      4,
      '<gen type="date" from="2026-01-02T00:00:00" order="sequential" step="12h" weekdays="mon..fri" format="YYYY-MM-DD HH:mm"/>',
    );
    // Friday 2 Jan gives 00:00 and 12:00; the weekend is skipped; Monday 5 Jan
    // resumes. A step alone could not say this.
    expect(rows(doc, ENGINES[0]![1])).toEqual([
      '2026-01-02 00:00',
      '2026-01-02 12:00',
      '2026-01-05 00:00',
      '2026-01-05 12:00',
    ]);
  });
});

describe('what the validator says about the open forms', () => {
  const codesOf = (gen: string): string[] => {
    const parsed = parse(config(3, gen));
    expect(parsed.diagnostics).toEqual([]);
    return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
  };

  it('accepts from= alone when the range is walked', () => {
    expect(codesOf('<gen type="date" from="2026-01-01" order="sequential"/>')).toEqual([]);
  });

  it('still refuses from= alone on a DRAWN date', () => {
    // Where the range is sampled, one end genuinely means nothing — TDC150 was
    // right for that case and stays.
    expect(codesOf('<gen type="date" from="2026-01-01"/>')).toContain('TDC150');
  });

  it('refuses a weekday it does not know', () => {
    expect(
      codesOf('<gen type="date" from="2026-01-01" order="sequential" weekdays="mon..frr"/>'),
    ).toContain('TDC249');
  });

  it('refuses weekdays= with a step that already fixes the weekday', () => {
    // A week/month/year step lands on the same weekday every time, so the filter
    // would match always or never — and the user would get a full column or an
    // empty one with nothing said.
    expect(
      codesOf('<gen type="date" from="2026-01-01" order="sequential" step="1w" weekdays="mon"/>'),
    ).toContain('TDC250');
  });

  it('refuses weekdays= without order="sequential" — nothing walks the axis', () => {
    expect(
      codesOf('<gen type="date" range="2026-01-01..2026-12-31" weekdays="mon..fri"/>'),
    ).toContain('TDC248');
  });
});

/**
 * The notation, after the first one was rejected for looking foreign to its own
 * language.
 *
 * Two faults were named, and both were real. `days="mon-fri"` used a hyphen where
 * every other range in TDC uses `..` — `length="6..9"`, `range="0..100"`. And
 * `step="15 minute"` was prose inside an attribute, a shape that appears nowhere
 * else here. The third fault was the one that mattered: with `step="day"` sitting
 * beside `days="mon-fri"`, the two attributes were near-homographs for entirely
 * different operations, and nobody could tell them apart.
 *
 * So: `..` for the span, `15m` for the step, and the filter renamed to
 * `weekdays=` so it cannot be read as a count of days.
 */
describe('the step notation', () => {
  const walk = (n: number, gen: string): string[] =>
    rows(config(n, `<gen type="date" from="2026-01-01T00:00:00" order="sequential" ${gen}/>`), {
      now: NOW,
      mode: 'memory',
    });

  it('adds up within the fixed units', () => {
    expect(walk(3, 'step="1h30m" format="YYYY-MM-DD HH:mm"')).toEqual([
      '2026-01-01 00:00',
      '2026-01-01 01:30',
      '2026-01-01 03:00',
    ]);
  });

  it('reads `m` as MINUTE, the way every notation like this does', () => {
    expect(walk(2, 'step="3m" format="YYYY-MM-DD HH:mm"')).toEqual([
      '2026-01-01 00:00',
      '2026-01-01 00:03',
    ]);
  });

  it('reads `mo` as month, and adds up within the calendar units', () => {
    expect(walk(3, 'step="1y6mo" format="YYYY-MM-DD"')).toEqual([
      '2026-01-01',
      '2027-07-01',
      '2029-01-01',
    ]);
  });

  it('still reads a bare number as days', () => {
    expect(walk(3, 'step="2" format="YYYY-MM-DD"')).toEqual([
      '2026-01-01',
      '2026-01-03',
      '2026-01-05',
    ]);
  });
});

describe('what the validator says about a step', () => {
  const codesOf = (gen: string): string[] => {
    const parsed = parse(config(3, gen));
    expect(parsed.diagnostics).toEqual([]);
    return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
  };
  const hintOf = (gen: string): string => {
    const found = validate(parse(config(3, gen)).tree).diagnostics.find((d) => d.code === 'TDC247');
    return `${found?.message ?? ''} :: ${found?.hint ?? ''}`;
  };
  const walked = (step: string): string =>
    `<gen type="date" from="2026-01-01" order="sequential" step="${step}"/>`;

  it('refuses a calendar unit mixed with a fixed one', () => {
    // "One month and fifteen days" is 43, 44, 45 or 46 days depending on which
    // is applied first. A config whose meaning turns on an invisible ordering is
    // worse than one that will not parse.
    expect(codesOf(walked('1mo15d'))).toContain('TDC247');
  });

  it('says WHY a mixed step is refused, rather than calling it a typo', () => {
    expect(hintOf(walked('1mo15d'))).toContain('mixes a calendar unit with a fixed one');
    expect(hintOf(walked('1mo15d'))).toContain('45d, or 1mo');
  });

  it('refuses a repeated unit rather than summing it', () => {
    // `1h30m1h` is a typo every time. Adding the two hours together would hide it.
    expect(codesOf(walked('1h30m1h'))).toContain('TDC247');
  });

  it('refuses the old spelled-out form, so there is one notation and not two', () => {
    expect(codesOf(walked('15 minute'))).toContain('TDC247');
    expect(codesOf(walked('month'))).toContain('TDC247');
  });

  it('shows the notation in the hint, since the value alone does not teach it', () => {
    expect(hintOf(walked('fortnight'))).toContain('15m, 1h30m, 2d, 3mo, 1y');
  });

  it('catches a weekday-fixing step by its LENGTH, not by its spelling', () => {
    // `14d` fixes the weekday exactly as `2w` does. The old test looked at the
    // unit name and would have let this one through.
    expect(
      codesOf('<gen type="date" from="2026-01-01" order="sequential" step="14d" weekdays="mon"/>'),
    ).toContain('TDC250');
    expect(
      codesOf('<gen type="date" from="2026-01-01" order="sequential" step="3d" weekdays="mon"/>'),
    ).not.toContain('TDC250');
  });
});
