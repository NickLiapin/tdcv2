/**
 * `peak_at=` — which row a seasonal wave is highest on.
 *
 * `base` + `amplitude` + `period="365"` could not say "warmer in summer". A
 * plain `sin(2π·i/period)` crosses zero at row 0 and peaks a QUARTER PERIOD
 * later, so a year of daily rows peaked in early April — the one season nobody
 * means. The workaround was `pattern` with hand-placed points, and `phase=`
 * earned "did you mean case?".
 *
 * ── Why a row and not an angle ───────────────────────────────────────────────
 * `period` is already counted in rows. A shift measured in radians would be a
 * second unit in one idea, and would ask the author to convert something they
 * already know: the peak is in July, July is row 182 of 365. `peak_at` takes
 * the row.
 *
 * ── Why the old outputs cannot move ──────────────────────────────────────────
 * The wave is now `cos(2π·(i − peak)/period)` with `peak` defaulting to
 * `period/4`, and `cos(x − π/2) === sin(x)`. That is not a claim about
 * refactoring being safe — it is why there is no second branch for the default,
 * and the first test below is what holds it.
 */

import { describe, expect, it } from 'vitest';

import { parseTimeseries, timeseriesValueAt } from '../../src/generators/timeseries.js';
import { parse } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { parseStrict } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const spec = (attrs: Record<string, string>) => parseTimeseries(attrs);

/** The wave alone, with no noise, rounded so a comparison reads. */
const wave = (attrs: Record<string, string>, rows: number): number[] => {
  const s = spec(attrs);
  return Array.from({ length: rows }, (_, i) => Math.round(timeseriesValueAt(s, i, 0) * 100) / 100);
};

const SEASON = { base: '15', amplitude: '10', period: '12' };

describe('the default wave', () => {
  it('is exactly the sine it always was', () => {
    // The whole reason `peak_at` could be added without a compatibility branch.
    const s = spec(SEASON);
    for (let i = 0; i < 24; i++) {
      const sine = 15 + 10 * Math.sin((2 * Math.PI * i) / 12);
      expect(timeseriesValueAt(s, i, 0)).toBeCloseTo(sine, 12);
    }
  });

  it('peaks a quarter period in — row 3 of 12, which is April', () => {
    const values = wave(SEASON, 12);
    expect(values.indexOf(Math.max(...values))).toBe(3);
  });
});

describe('peak_at moves the peak to the row it names', () => {
  it('puts the summer peak in July', () => {
    const values = wave({ ...SEASON, peak_at: '6' }, 12);
    expect(values.indexOf(Math.max(...values))).toBe(6);
    expect(values[6]).toBe(25);
  });

  it('puts the trough half a period from the peak', () => {
    const values = wave({ ...SEASON, peak_at: '6' }, 12);
    expect(values.indexOf(Math.min(...values))).toBe(0);
    expect(values[0]).toBe(5);
  });

  it('accepts a peak on row 0, which the old shape could not express', () => {
    // A January peak needs the wave to START at its maximum. `sin` cannot: it
    // starts at zero however the amplitude is chosen.
    const values = wave({ ...SEASON, peak_at: '0' }, 12);
    expect(values[0]).toBe(25);
  });

  it('wraps, so a peak beyond the period names the same row within it', () => {
    expect(wave({ ...SEASON, peak_at: '6' }, 12)).toEqual(wave({ ...SEASON, peak_at: '18' }, 12));
  });

  it('takes a fraction, since a peak need not land on a row', () => {
    const values = wave({ ...SEASON, peak_at: '6.5' }, 12);
    // A peak halfway between two rows leaves them at the same height.
    expect(values[6]).toBeCloseTo(values[7] ?? Number.NaN, 10);
  });
});

describe('what the validator says', () => {
  const codes = (gen: string): string[] => {
    const doc =
      '<tdc><env count="3" seed="s" local="en">' +
      `<sequence name="T">${gen}</sequence></env>` +
      '<block><line><data>${{T}}</data></line></block></tdc>';
    const parsed = parse(doc);
    expect(parsed.diagnostics).toEqual([]);
    return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
  };

  it('accepts peak_at beside a period', () => {
    expect(
      codes('<gen type="timeseries" base="15" amplitude="10" period="12" peak_at="6"/>'),
    ).toEqual([]);
  });

  it('refuses a peak_at that is not a number', () => {
    expect(
      codes('<gen type="timeseries" base="15" amplitude="10" period="12" peak_at="summer"/>'),
    ).toContain('TDC252');
  });

  it('refuses peak_at with no period — there is no wave to place a peak on', () => {
    expect(codes('<gen type="timeseries" base="15" amplitude="10" peak_at="6"/>')).toContain(
      'TDC253',
    );
  });

  it('answers phase= with peak_at rather than with "did you mean case"', () => {
    const doc =
      '<tdc><env count="3" seed="s" local="en"><sequence name="T">' +
      '<gen type="timeseries" base="15" amplitude="10" period="12" phase="6"/>' +
      '</sequence></env><block><line><data>${{T}}</data></line></block></tdc>';
    const found = validate(parse(doc).tree).diagnostics.find((d) => d.code === 'TDC015');
    expect(found?.hint).toContain('peak_at=');
    expect(found?.suggestion).toBeUndefined();
  });
});

describe('through the engines', () => {
  const doc =
    '<tdc><env count="12" seed="w" local="en"><sequence name="T">' +
    '<gen type="timeseries" base="15" amplitude="10" period="12" peak_at="6" decimals="1"/>' +
    '</sequence></env><block><line><data>${{T}}</data></line></block></tdc>';

  it('agrees on all three', () => {
    const memory = render(parseStrict(doc), { mode: 'memory' });
    expect(render(parseStrict(doc), { stream: true })).toBe(memory);
    expect(render(parseStrict(doc), { mode: 'disk' })).toBe(memory);
    expect(memory.split('\n').filter(Boolean)[6]).toBe('25.0');
  });
});
