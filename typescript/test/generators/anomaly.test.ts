/**
 * Anomaly injection (`anomaly="p"`) — outlier spikes on a numeric gen, both
 * engines, deterministic and seekable (fixed seed → exact outlier count).
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const dsl = (genAttrs: string): string =>
  `<tdc><env count="5000" seed="anom"><sequence name="V"><gen type="number" value="10..20" ${genAttrs}/></sequence></env>` +
  `<block><line><data>\${{V}}</data></line></block></tdc>`;

const nums = (genAttrs: string, opts: RenderOptions): number[] =>
  render(parseStrict(dsl(genAttrs)), opts)
    .split('\n')
    .filter(Boolean)
    .map(Number);

describe('anomaly="p" — outlier injection, both engines', () => {
  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`about p of the values become outliers × factor (${label})`, () => {
      // base range is 10..20; anomalies (× 100) land at ≥ 1000 — unambiguous.
      const xs = nums('anomaly="0.02" anomaly_factor="100"', opts);
      const outliers = xs.filter((x) => x >= 1000).length;
      expect(outliers).toBeGreaterThan(60); // ≈ 2% of 5000 = 100
      expect(outliers).toBeLessThan(140);
      // normal values are still in-range.
      expect(xs.filter((x) => x >= 10 && x <= 20).length).toBeGreaterThan(4800);
    });

    it(`anomaly="0" injects nothing (${label})`, () => {
      const xs = nums('anomaly="0"', opts);
      expect(xs.every((x) => x >= 10 && x <= 20)).toBe(true);
    });
  }

  it('is deterministic: same seed → identical output', () => {
    const a = nums('anomaly="0.02" anomaly_factor="100"', { now: NOW, engine: 1 });
    const b = nums('anomaly="0.02" anomaly_factor="100"', { now: NOW, engine: 1 });
    expect(a).toEqual(b);
  });

  it('combines with missing (some rows spiked, some blanked)', () => {
    const lines = render(
      parseStrict(
        `<tdc><env count="4000" seed="am"><sequence name="V"><gen type="number" value="10..20" anomaly="0.1" anomaly_factor="100" missing="0.1"/></sequence></env>` +
          `<block><line><data>[\${{V}}]</data></line></block></tdc>`,
      ),
      { now: NOW, engine: 1 },
    )
      .split('\n')
      .filter(Boolean);
    expect(lines.some((l) => l === '[]')).toBe(true); // some blanked
    expect(lines.some((l) => Number(l.slice(1, -1)) >= 1000)).toBe(true); // some spiked
  });

  /**
   * A spike used to be multiplied and re-stringified, which threw away
   * everything the column had already been rendered with. The outlier rows were
   * the only ones in the file with a different shape:
   *
   *     length="5"    00014 00046 …  and then  117
   *     decimals="2"  85.66 40.97 …  and then  6.445
   *
   * A column of fixed-width identifiers stopped being fixed width on exactly
   * the rows a test is about to exercise, and a column declared with `decimals`
   * is typed a float in Parquet — a third place is a value the declared type
   * never promised.
   */
  it('a spike keeps the width the column was padded to', () => {
    const lines = render(
      parseStrict(
        `<tdc><env count="200" seed="shape"><sequence name="V"><gen type="number" value="1..99" length="5" anomaly="0.4" anomaly_factor="3"/></sequence></env>` +
          `<block><line><data>\${{V}}</data></line></block></tdc>`,
      ),
      { now: NOW, engine: 1 },
    )
      .split('\n')
      .filter(Boolean);
    expect(lines.every((l) => l.length === 5)).toBe(true);
    expect(lines.some((l) => Number(l) > 99)).toBe(true); // some really were spiked
  });

  it('a spike keeps the decimal places the column declared', () => {
    const lines = render(
      parseStrict(
        `<tdc><env count="200" seed="shape"><sequence name="V"><gen type="number" value="1..99" decimals="2" anomaly="0.4" anomaly_factor="100"/></sequence></env>` +
          `<block><line><data>\${{V}}</data></line></block></tdc>`,
      ),
      { now: NOW, engine: 1 },
    )
      .split('\n')
      .filter(Boolean);
    expect(lines.every((l) => /^\d+\.\d{2}$/.test(l))).toBe(true);
    // Above the range's own ceiling, so these rows can only be spikes.
    expect(lines.some((l) => Number(l) > 99)).toBe(true);
  });

  /** And a column that was never padded does not acquire padding. */
  it('a plain integer column stays plain', () => {
    const lines = render(
      parseStrict(
        `<tdc><env count="200" seed="shape"><sequence name="V"><gen type="number" value="10..99" anomaly="0.4" anomaly_factor="10"/></sequence></env>` +
          `<block><line><data>\${{V}}</data></line></block></tdc>`,
      ),
      { now: NOW, engine: 1 },
    )
      .split('\n')
      .filter(Boolean);
    expect(lines.some((l) => l.length === 3)).toBe(true); // spiked, three digits
    expect(lines.every((l) => !l.startsWith('0'))).toBe(true);
  });
});
