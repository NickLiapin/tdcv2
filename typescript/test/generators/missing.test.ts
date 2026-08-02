/**
 * Missing-data injection (`missing="p"`) — MCAR: each value is independently
 * blanked with probability p. Cross-cutting (any gen), deterministic, seekable
 * (works in both engines). The seed is fixed so the blank counts are exact.
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

// `[${{V}}]` so a blank value shows as "[]" (survives filter(Boolean)).
const dsl = (genAttrs: string): string =>
  `<tdc><env count="5000" seed="miss"><sequence name="V"><gen type="number" value="1..100" ${genAttrs}/></sequence></env>` +
  `<block><line><data>[\${{V}}]</data></line></block></tdc>`;

const lines = (genAttrs: string, opts: RenderOptions): string[] =>
  render(parseStrict(dsl(genAttrs)), opts)
    .split('\n')
    .filter(Boolean);

describe('missing="p" — MCAR blanking, both engines', () => {
  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`blanks about p of the values (${label})`, () => {
      const blanks = lines('missing="0.3"', opts).filter((l) => l === '[]').length;
      expect(blanks).toBeGreaterThan(1300); // ≈ 1500 of 5000
      expect(blanks).toBeLessThan(1700);
    });

    it(`missing="0" never blanks; the values are still valid (${label})`, () => {
      const out = lines('missing="0"', opts);
      expect(out.some((l) => l === '[]')).toBe(false);
      expect(out.every((l) => /^\[\d+\]$/.test(l))).toBe(true);
    });
  }

  it('missing_as sets the placeholder token', () => {
    const out = lines('missing="0.5" missing_as="NULL"', { now: NOW, engine: 1 });
    expect(out.some((l) => l === '[NULL]')).toBe(true);
    expect(out.some((l) => l === '[]')).toBe(false);
  });

  it('is deterministic: same seed → identical blanks', () => {
    const a = lines('missing="0.3"', { now: NOW, engine: 1 });
    const b = lines('missing="0.3"', { now: NOW, engine: 1 });
    expect(a).toEqual(b);
  });
});
