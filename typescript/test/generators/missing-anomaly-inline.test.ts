/**
 * Regression guard: `missing` / `anomaly` on the INLINE-built streaming gen
 * types — text, increment/decrement, timeseries, pattern.
 *
 * These bypass `buildGenValues` in the streaming/disk engine (they have their
 * own seekable builders), so they used to silently DROP `missing`/`anomaly` —
 * a real correctness bug given disk/streaming is the default engine. The other
 * types (number/regex/template/…) route through resolveGenValueAt and were fine
 * (covered by missing.test.ts / anomaly.test.ts, which use type="number").
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const N = 2000;

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

const doc = (seqBody: string) =>
  `<tdc><env count="${String(N)}" seed="ma" inject="\${{%}}">` +
  `<sequence name="V">${seqBody}</sequence></env>` +
  `<block><line><data>[\${{V}}]</data></line></block></tdc>`;

const lines = (seqBody: string, opts: RenderOptions): string[] =>
  render(parseStrict(doc(seqBody)), opts)
    .split('\n')
    .filter(Boolean);

describe('missing on inline streaming types — applied in every engine', () => {
  const cases: readonly [string, string][] = [
    ['text', '<gen type="text" value="A,B,C" missing="0.4" missing_as="NULL"/>'],
    ['increment', '<gen type="increment" value="1" missing="0.4" missing_as="NULL"/>'],
    ['timeseries', '<gen type="timeseries" base="100" trend="1" missing="0.4" missing_as="NULL"/>'],
    ['pattern', '<gen type="pattern" points="0,0 50,100 100,0" missing="0.4" missing_as="NULL"/>'],
  ];
  for (const [type, body] of cases) {
    for (const [label, opts] of ENGINES) {
      it(`${type} blanks ≈40% (${label})`, () => {
        const blanks = lines(body, opts).filter((l) => l === '[NULL]').length;
        // ≈ 800 of 2000; wide band since each engine uses its own PRNG stream.
        expect(blanks, `${type}/${label}`).toBeGreaterThan(650);
        expect(blanks, `${type}/${label}`).toBeLessThan(950);
      });
    }
  }
});

describe('anomaly on an inline numeric type (text) — applied in every engine', () => {
  // text values 1/2/3 (all < 10), spiked ×1000 → an outlier is unmistakably ≥ 1000.
  for (const [label, opts] of ENGINES) {
    it(`spikes ≈40% (${label})`, () => {
      const out = lines(
        '<gen type="text" value="1,2,3" anomaly="0.4" anomaly_factor="1000"/>',
        opts,
      );
      const spikes = out.filter((l) => Number(l.slice(1, -1)) >= 1000).length;
      expect(spikes, label).toBeGreaterThan(650); // ≈ 800 of 2000
      expect(spikes, label).toBeLessThan(950);
    });
  }
});

describe('missing="0" on inline types never blanks', () => {
  for (const [label, opts] of ENGINES) {
    it(`text stays intact (${label})`, () => {
      const out = lines('<gen type="text" value="A,B" missing="0"/>', opts);
      expect(
        out.some((l) => l === '[]'),
        label,
      ).toBe(false);
      expect(
        out.every((l) => l === '[A]' || l === '[B]'),
        label,
      ).toBe(true);
    });
  }
});
