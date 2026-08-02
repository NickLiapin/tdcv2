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
