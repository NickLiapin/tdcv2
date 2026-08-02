/**
 * Statistical distributions wired end-to-end through a real render.
 *
 * The pure math is golden-tested in `distribution.test.ts`; here we check the
 * `<gen type="number" distribution="...">` attribute actually drives generation:
 * correct shape (mean/sd/positivity/tail), determinism, decimals and clip. The
 * seed is fixed, so every assertion is deterministic — the bands only need to
 * contain the (fixed) sampled statistic.
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const dsl = (genAttrs: string): string =>
  `<tdc><env count="8000" seed="dist"><sequence name="V"><gen type="number" ${genAttrs}/></sequence></env>` +
  `<block><line><data>\${{V}}</data></line></block></tdc>`;

const values = (genAttrs: string, opts: RenderOptions): number[] =>
  render(parseStrict(dsl(genAttrs)), opts)
    .split('\n')
    .filter(Boolean)
    .map(Number);

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const stdev = (xs: number[]): number => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('distributions — in-memory engine (Engine 1)', () => {
  const memory: RenderOptions = { now: NOW, engine: 1 };

  it('normal: sample mean/sd match the parameters; integer output by default', () => {
    const xs = values('distribution="normal" mean="100" sd="15"', memory);
    expect(xs).toHaveLength(8000);
    expect(mean(xs)).toBeGreaterThan(99);
    expect(mean(xs)).toBeLessThan(101);
    expect(stdev(xs)).toBeGreaterThan(14);
    expect(stdev(xs)).toBeLessThan(16);
    expect(xs.every(Number.isInteger)).toBe(true); // decimals default 0
  });

  it('decimals allows fractions; min clips the low tail', () => {
    const raw = render(
      parseStrict(dsl('distribution="normal" mean="0" sd="1" decimals="2" min="0"')),
      memory,
    )
      .split('\n')
      .filter(Boolean);
    expect(raw.every((s) => Number(s) >= 0)).toBe(true); // clipped at 0
    expect(raw.some((s) => s.includes('.'))).toBe(true); // 2 decimals present
  });

  it('exponential is strictly positive; pareto sits above xmin with a heavy tail', () => {
    const exp = values('distribution="exponential" rate="1" decimals="3"', memory);
    expect(exp.every((x) => x >= 0)).toBe(true); // a tiny value can round to 0.000
    expect(Math.max(...exp)).toBeGreaterThan(3); // exponential tail (rate=1)
    const par = values('distribution="pareto" alpha="2" xmin="10"', memory);
    expect(par.every((x) => x >= 10)).toBe(true);
    expect(Math.max(...par)).toBeGreaterThan(50); // long tail far exceeds xmin
  });

  it('is deterministic: same seed → identical output', () => {
    const a = values('distribution="normal" mean="0" sd="1"', memory);
    const b = values('distribution="normal" mean="0" sd="1"', memory);
    expect(a).toEqual(b);
  });
});

describe('distributions — streaming engine (Engine 2), seekable per row', () => {
  const stream: RenderOptions = { now: NOW, engine: 2 };

  it('normal: correct shape and integer output', () => {
    const xs = values('distribution="normal" mean="100" sd="15"', stream);
    expect(xs).toHaveLength(8000);
    expect(mean(xs)).toBeGreaterThan(99);
    expect(mean(xs)).toBeLessThan(101);
    expect(stdev(xs)).toBeGreaterThan(14);
    expect(stdev(xs)).toBeLessThan(16);
    expect(xs.every(Number.isInteger)).toBe(true);
  });

  it('pareto keeps its heavy tail; exponential stays non-negative', () => {
    const par = values('distribution="pareto" alpha="2" xmin="10"', stream);
    expect(par.every((x) => x >= 10)).toBe(true);
    expect(Math.max(...par)).toBeGreaterThan(50);
    const exp = values('distribution="exponential" rate="1" decimals="2"', stream);
    expect(exp.every((x) => x >= 0)).toBe(true);
  });

  it('is deterministic per row: same seed → identical output', () => {
    const a = values('distribution="normal" mean="0" sd="1"', stream);
    const b = values('distribution="normal" mean="0" sd="1"', stream);
    expect(a).toEqual(b);
  });
});

describe('distributions slice 2 — weibull / poisson / zipf, both engines', () => {
  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`poisson: integer counts with mean ≈ lambda (${label})`, () => {
      const xs = values('distribution="poisson" lambda="4"', opts);
      expect(xs.every(Number.isInteger)).toBe(true);
      expect(xs.every((x) => x >= 0)).toBe(true);
      expect(mean(xs)).toBeGreaterThan(3.5);
      expect(mean(xs)).toBeLessThan(4.5);
    });

    it(`zipf: ranks stay in 1..n and rank 1 dominates (${label})`, () => {
      const xs = values('distribution="zipf" n="10" s="1"', opts);
      expect(xs.every((x) => x >= 1 && x <= 10)).toBe(true);
      const rank1 = xs.filter((x) => x === 1).length;
      expect(rank1).toBeGreaterThan(xs.length / 5); // clearly the most frequent rank
    });

    it(`weibull: non-negative, integer by default (${label})`, () => {
      const xs = values('distribution="weibull" shape="2" scale="100"', opts);
      expect(xs.every((x) => x >= 0)).toBe(true);
      expect(xs.every(Number.isInteger)).toBe(true);
    });

    it(`gamma: non-negative, mean ≈ shape·scale (${label})`, () => {
      const xs = values('distribution="gamma" shape="2" scale="10" decimals="2"', opts);
      expect(xs.every((x) => x >= 0)).toBe(true);
      expect(mean(xs)).toBeGreaterThan(18); // shape·scale = 20
      expect(mean(xs)).toBeLessThan(22);
    });

    it(`beta: within [0,1], mean ≈ a/(a+b) (${label})`, () => {
      const xs = values('distribution="beta" alpha="2" beta="5" decimals="3"', opts);
      expect(xs.every((x) => x >= 0 && x <= 1)).toBe(true);
      expect(mean(xs)).toBeGreaterThan(0.24); // 2/(2+5) ≈ 0.286
      expect(mean(xs)).toBeLessThan(0.33);
    });
  }
});
