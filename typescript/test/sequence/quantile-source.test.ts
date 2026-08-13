/**
 * `<gen type="file" read="quantile">` — a sample read as a distribution.
 *
 * The feature exists because `weight=`, which is exact and is the right answer
 * for a countable value, can only ever emit values that were written in the
 * file. A thousand-line sample stretched to a million rows still holds a
 * thousand distinct values with nothing between them — a comb, and for a
 * MEASURED quantity that comb is structure the real data never had.
 *
 * So the tests below check two different things, and both matter:
 *
 *  - **the shape survives** — the generated quantiles match the source's;
 *  - **the comb is gone** — the run holds far more distinct values than the
 *    sample did, and they lie between the observed ones rather than beyond them.
 *
 * `sample="exact"` then removes the sampling noise entirely by sweeping the
 * distribution instead of drawing from it, which is checked here as a MEASURED
 * comparison against the drawn form rather than as a claim.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TDC } from '../../src/lib/tdc.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const DIR = mkdtempSync(join(tmpdir(), 'tdc-quantile-'));

/** Write a sample file and return its path. */
function sample(name: string, lines: readonly (string | number)[]): string {
  const path = join(DIR, name);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

function config(src: string, attrs = '', count = 10): string {
  return (
    `<tdc><env count="${String(count)}" seed="qs" local="en">` +
    `<sequence name="A"><gen type="file" src="${src}" read="quantile" ${attrs}/></sequence>` +
    '</env><block><line><data>${{A}}</data></line></block></tdc>'
  );
}

function run(cfg: string, engine: 1 | 2): string[] {
  return new TDC({ configString: cfg, engine })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

function bothEngines(cfg: string): string[] {
  const memory = run(cfg, 1);
  expect(run(cfg, 2)).toEqual(memory);
  return memory;
}

/**
 * The value at probability p of an ascending list, interpolated.
 *
 * Observation `i` sits at `(i + 0.5) / n`, the same convention the engine uses —
 * and it has to be the same, or this would measure the CONVENTION rather than
 * the fidelity. Measured both ways on a 951-value sample: each convention
 * reproduces its own definition to 0.0000% and reads 1.28% off against the
 * other. The reason to prefer this one is not accuracy against a reference, it
 * is that every observation then owns exactly `1/n` of the run — including the
 * smallest and the largest, which the ends convention paid half.
 */
function quantile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, p * sorted.length - 0.5));
  const lo = Math.floor(i);
  const a = sorted[lo] ?? 0;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)] ?? a;
  return a + (i - lo) * (b - a);
}

describe('a file read as a quantile function', () => {
  it('produces values BETWEEN the observations, and none outside them', () => {
    const src = sample('gaps.txt', [10, 20, 30, 40]);
    const values = bothEngines(config(src, '', 200)).map(Number);
    // Nothing beyond the sample: the file cannot support a claim about values
    // it never saw, so the generated range is exactly the observed one.
    expect(Math.min(...values)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...values)).toBeLessThanOrEqual(40);
    // And the gaps are filled, which is the entire point.
    expect(values.some((v) => v > 10 && v < 20)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(4);
  });

  it('writes the answer with the same precision as the source', () => {
    // A whole-number sample is a whole-number quantity — 35.4 orders is not an
    // answer — so the source's own precision decides, with no attribute to set.
    const whole = bothEngines(config(sample('whole.txt', [10, 20, 30, 40]), '', 20));
    for (const v of whole) expect(v).toMatch(/^\d+$/);

    const cents = bothEngines(config(sample('cents.txt', ['10.00', '20.50', '30.99']), '', 20));
    for (const v of cents) expect(v).toMatch(/^\d+\.\d\d$/);
  });

  it('lets decimals= override the source precision', () => {
    const values = bothEngines(config(sample('over.txt', [10, 40]), 'decimals="3"', 10));
    for (const v of values) expect(v).toMatch(/^\d+\.\d{3}$/);
  });

  it('keeps a repeated value as an atom, at its own share', () => {
    // Half the sample is the single value 5, so half the run should be 5 — a
    // flat shelf in the middle of a continuum, which is how a discrete value
    // survives beside interpolated ones.
    const src = sample('atom.txt', [1, 5, 5, 5, 5, 9]);
    const values = bothEngines(config(src, 'sample="exact"', 1000)).map(Number);
    const fives = values.filter((v) => v === 5).length;
    expect(fives / values.length).toBeGreaterThan(0.5);
    expect(fives / values.length).toBeLessThan(0.75);
  });

  it('cures the comb: far more distinct values than the sample held', () => {
    const source = Array.from({ length: 50 }, (_, i) => (i + 1) * 3);
    const src = sample('comb.txt', source);
    const drawn = bothEngines(config(src, 'decimals="2"', 2000)).map(Number);
    expect(new Set(drawn).size).toBeGreaterThan(source.length * 10);

    // The comparison that makes the point: the same file read the ordinary way
    // can only ever produce the fifty values it holds.
    const plain = new TDC({
      configString:
        `<tdc><env count="2000" seed="qs" local="en">` +
        `<sequence name="A"><gen type="file" src="${src}"/></sequence>` +
        '</env><block><line><data>${{A}}</data></line></block></tdc>',
      engine: 2,
    })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(new Set(plain).size).toBeLessThanOrEqual(source.length);
  });

  it('sample="exact" reproduces the source far more closely than drawing does', () => {
    // A skewed sample, so the comparison is not flattered by symmetry.
    const source = Array.from({ length: 400 }, (_, i) => Number((1000 / (i + 1)).toFixed(2)));
    const sorted = [...source].sort((a, b) => a - b);
    const src = sample(
      'skew.txt',
      source.map((v) => v.toFixed(2)),
    );

    const worst = (values: readonly number[]): number => {
      const got = [...values].sort((a, b) => a - b);
      let max = 0;
      for (let p = 5; p <= 95; p += 5) {
        const want = quantile(sorted, p / 100);
        max = Math.max(max, Math.abs(quantile(got, p / 100) - want) / want);
      }
      return max;
    };

    const exact = worst(bothEngines(config(src, 'sample="exact"', 4000)).map(Number));
    const drawn = worst(bothEngines(config(src, '', 4000)).map(Number));
    expect(exact).toBeLessThan(0.005);
    expect(exact).toBeLessThan(drawn);
  });

  it('sample="exact" does not hand back a sorted column', () => {
    // Without the seeded permutation the sweep would come out in order, which is
    // reproducible and useless — no one wants a sorted dataset.
    const values = bothEngines(config(sample('order.txt', [1, 2, 3, 4, 5]), 'sample="exact"', 200));
    const asNumbers = values.map(Number);
    const ascending = [...asNumbers].sort((a, b) => a - b);
    expect(asNumbers).not.toEqual(ascending);
  });

  it('gives every observation the same weight, edges included', () => {
    // The convention question, and it is not cosmetic. Placing observation `i`
    // at `i / (n - 1)` — at the ENDS of the sample rather than in the middle of
    // the slice it owns — gives the smallest and largest exactly HALF their
    // weight, because there is nothing on the far side of them to ramp from.
    // Measured before this was fixed, on this very file: 0.505% at each end and
    // 1.010% in the middle, against the 1.000% each of them owes.
    const src = sample(
      'even.txt',
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    const rows = 20000;
    const counts = new Map<string, number>();
    for (const v of bothEngines(config(src, 'sample="exact"', rows))) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(counts.size).toBe(100);
    for (const [, n] of counts) {
      // Every value lands within a tenth of a percent of its 1.000%.
      expect(Math.abs(n / rows - 0.01)).toBeLessThan(0.001);
    }
  });

  it('refuses a line that is not a number, and says which line', () => {
    const src = sample('bad.txt', [10, 'twenty', 30]);
    expect(() => run(config(src), 2)).toThrow(/line 2 .* is "twenty"/s);
  });
});

describe('the readings a file cannot have at once', () => {
  const diagnose = (attrs: string): (string | undefined)[] =>
    validate(
      parse(
        `<tdc><env count="3" seed="q" local="en">` +
          `<sequence name="A"><gen type="file" src="x.txt" ${attrs}/></sequence>` +
          '</env><block><line><data>${{A}}</data></line></block></tdc>',
      ).tree,
    ).diagnostics.map((d) => d.code);

  it('names the only reading there is', () => {
    expect(diagnose('read="quantle"')).toContain('TDC297');
  });

  it('refuses weight= beside it — two different places to keep the shares', () => {
    expect(diagnose('column="v" weight="c" read="quantile"')).toContain('TDC297');
  });

  it('refuses row= beside it — a quantile answer is not a line of the file', () => {
    expect(diagnose('column="v" row="i" read="quantile"')).toContain('TDC297');
  });

  it('refuses order="sequential" beside it', () => {
    expect(diagnose('read="quantile" order="sequential"')).toContain('TDC297');
  });

  it('refuses sample= on a file that is not read as a distribution', () => {
    expect(diagnose('sample="exact"')).toContain('TDC297');
  });

  it('accepts the two forms that are meant to work', () => {
    expect(diagnose('read="quantile"')).not.toContain('TDC297');
    expect(diagnose('read="quantile" sample="exact"')).not.toContain('TDC297');
  });
});
