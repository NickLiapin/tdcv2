/**
 * Time-series generator — value(i) = base + trend·i + amplitude·sin(2π i/period)
 * + noise·z. Index-dependent (like counters), so it is special-cased in both
 * engines with the real row index; deterministic and seekable.
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { parseTimeseries, timeseriesValueAt } from '../../src/generators/timeseries.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('timeseriesValueAt — the layered value', () => {
  const spec = (attrs: Record<string, string | undefined>) => parseTimeseries(attrs);

  it('base + linear trend', () => {
    expect(timeseriesValueAt(spec({ base: '100', trend: '2' }), 10, 0)).toBe(120);
  });

  it('adds a sinusoidal seasonal wave', () => {
    const s = spec({ period: '4', amplitude: '10' });
    expect(timeseriesValueAt(s, 1, 0)).toBeCloseTo(10, 10); // sin(π/2)=1
    expect(timeseriesValueAt(s, 2, 0)).toBeCloseTo(0, 10); // sin(π)=0
    expect(timeseriesValueAt(s, 3, 0)).toBeCloseTo(-10, 10); // sin(3π/2)=-1
  });

  it('adds noise·z', () => {
    expect(timeseriesValueAt(spec({ base: '50', noise: '5' }), 0, 2)).toBe(60); // 50 + 5·2
  });

  it('validates numeric params', () => {
    expect(() => parseTimeseries({ period: '-1' })).toThrow(/period/);
    expect(() => parseTimeseries({ noise: '-3' })).toThrow(/noise/);
    expect(() => parseTimeseries({ trend: 'abc' })).toThrow(/trend/);
  });
});

describe('timeseries — end to end, both engines', () => {
  const dsl = `<tdc><env count="1000" seed="ts">
      <sequence name="Sales"><gen type="timeseries" base="1000" trend="5" period="7" amplitude="100" noise="20"/></sequence>
    </env><block><line><data>\${{Sales}}</data></line></block></tdc>`;

  const nums = (opts: RenderOptions): number[] =>
    render(parseStrict(dsl), opts).split('\n').filter(Boolean).map(Number);
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`the trend makes later rows larger on average (${label})`, () => {
      const xs = nums(opts);
      expect(xs).toHaveLength(1000);
      const first = mean(xs.slice(0, 100)); // ~row 50 → base+250
      const last = mean(xs.slice(-100)); // ~row 950 → base+4750
      expect(last - first).toBeGreaterThan(4000); // trend·(900) ≈ 4500 dominates noise/season
    });
  }

  it('is deterministic: same seed → identical series', () => {
    expect(nums({ now: NOW, engine: 1 })).toEqual(nums({ now: NOW, engine: 1 }));
  });
});

/*
 * Several seasonalities at once, and noise that remembers the row before it —
 * the two things this page promised and did not have.
 */
describe('stacked seasonal waves', () => {
  const stacked = `<tdc><env count="21" seed="two" local="en">
    <sequence name="S"><gen type="timeseries" base="1000" period="7,365" amplitude="120,400" peak_at="5,182" decimals="0"/></sequence>
  </env><block><line><data>\${{S}}</data></line></block></tdc>`;

  it('peaks on the row peak_at names, every period', () => {
    const v = render(parseStrict(stacked), { now: NOW }).split('\n').filter(Boolean).map(Number);
    // The weekly wave peaks at 5, 12 and 19; each is higher than both neighbours.
    for (const peak of [5, 12, 19]) {
      expect(v[peak]).toBeGreaterThan(v[peak - 1]!);
      expect(v[peak]).toBeGreaterThan(v[peak + 1]!);
    }
  });

  it('sums the waves rather than replacing one with the other', () => {
    const only = (attrs: string): number[] =>
      render(
        parseStrict(
          `<tdc><env count="21" seed="two" local="en"><sequence name="S">` +
            `<gen type="timeseries" base="1000" ${attrs} decimals="6"/></sequence></env>` +
            `<block><line><data>\${{S}}</data></line></block></tdc>`,
        ),
        { now: NOW },
      )
        .split('\n')
        .filter(Boolean)
        .map(Number);
    const week = only('period="7" amplitude="120" peak_at="5"');
    const year = only('period="365" amplitude="400" peak_at="182"');
    const both = only('period="7,365" amplitude="120,400" peak_at="5,182"');
    for (let i = 0; i < both.length; i++) {
      // base counted once, so the two waves add on top of one base.
      expect(both[i]).toBeCloseTo(week[i]! + year[i]! - 1000, 5);
    }
  });

  it('a single wave is exactly what it always was', () => {
    const one =
      `<tdc><env count="12" seed="two" local="en"><sequence name="S">` +
      `<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30" decimals="2"/></sequence></env>` +
      `<block><line><data>\${{S}}</data></line></block></tdc>`;
    // The bytes this config produced before period= learned to be a list, taken
    // from a build of the commit before it. A wave that reads its own amplitude
    // out of a one-entry list has to land on exactly these.
    expect(render(parseStrict(one), { now: NOW }).split('\n').filter(Boolean).slice(0, 4)).toEqual([
      '1047.69',
      '1106.47',
      '1131.33',
      '1082.21',
    ]);
  });
});

describe('noise_correlation — noise that remembers', () => {
  const series = (phi: string, count = 20000): number[] =>
    render(
      parseStrict(
        `<tdc><env count="${String(count)}" seed="stat" local="en"><sequence name="C">` +
          `<gen type="timeseries" base="0" noise="1" noise_correlation="${phi}" decimals="6"/></sequence></env>` +
          `<block><line><data>\${{C}}</data></line></block></tdc>`,
      ),
      { now: NOW },
    )
      .split('\n')
      .filter(Boolean)
      .map(Number);

  const autocorrelation = (v: readonly number[], lag: number): number => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const centred = v.map((x) => x - mean);
    let top = 0;
    let bottom = 0;
    for (let i = 0; i < centred.length; i++) {
      bottom += centred[i]! ** 2;
      if (i + lag < centred.length) top += centred[i]! * centred[i + lag]!;
    }
    return top / bottom;
  };

  /*
   * The promise is AR(1), whose autocorrelation at lag h is φ^h. Measuring that
   * is the only test worth writing: asserting the values would pin the sample
   * rather than the property, and a wrong window or a missing normaliser would
   * still pass.
   */
  it('reproduces the autocorrelation of an AR(1) process', () => {
    const v = series('0.9');
    expect(autocorrelation(v, 1)).toBeCloseTo(0.9, 1);
    expect(autocorrelation(v, 2)).toBeCloseTo(0.81, 1);
    expect(autocorrelation(v, 5)).toBeCloseTo(0.9 ** 5, 1);
  });

  it('leaves the spread alone — correlation is not amplification', () => {
    const sd = (v: readonly number[]): number => {
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
    };
    // A running sum would grow with φ; this stays put, which is what the
    // normaliser in `correlatedNoise` is for.
    expect(sd(series('0'))).toBeCloseTo(1, 1);
    expect(sd(series('0.5'))).toBeCloseTo(1, 1);
    expect(sd(series('0.9'))).toBeCloseTo(1, 1);
  });

  it('at zero it is the white noise this generator always produced', () => {
    const plain =
      `<tdc><env count="12" seed="stat" local="en"><sequence name="C">` +
      `<gen type="timeseries" base="0" noise="1" decimals="6"/></sequence></env>` +
      `<block><line><data>\${{C}}</data></line></block></tdc>`;
    expect(
      render(parseStrict(plain.replace('noise="1"', 'noise="1" noise_correlation="0"')), {
        now: NOW,
      }),
    ).toBe(render(parseStrict(plain), { now: NOW }));
  });

  it('the engines agree, including across the window boundary', () => {
    const config =
      `<tdc><env count="300" seed="two-engines" local="en"><sequence name="C">` +
      `<gen type="timeseries" base="100" trend="0.1" period="7,90" amplitude="5,20" noise="2" noise_correlation="0.85" decimals="4"/></sequence></env>` +
      `<block><line><data>\${{C}}</data></line></block></tdc>`;
    expect(render(parseStrict(config), { now: NOW, engine: 2 })).toBe(
      render(parseStrict(config), { now: NOW }),
    );
  });
});
