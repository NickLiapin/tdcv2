/**
 * `anomaly_flag="NAME"` — ground-truth companion column marking which rows were
 * turned into anomalies. The flag must match the actual spike on every row, in
 * every engine, so a detector can be scored against the truth.
 */

import { describe, expect, it } from 'vitest';

import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/validate.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const N = 500;

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

// value 1/2/3 (all < 10); spiked ×1000 → an outlier is unmistakably >= 1000.
const doc =
  `<tdc><env count="${String(N)}" seed="af" inject="\${{%}}">` +
  `<sequence name="V">` +
  `<gen type="number" value="1..3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag"/>` +
  `</sequence></env>` +
  `<block><line><data>\${{V}}|\${{Flag}}</data></line></block></tdc>`;

const rows = (opts: RenderOptions): [number, string][] =>
  render(parseStrict(doc), opts)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [v, f] = l.split('|');
      return [Number(v), f ?? ''];
    });

describe('anomaly_flag marks exactly the spiked rows', () => {
  for (const [label, opts] of ENGINES) {
    it(`flag matches the spike on every row (${label})`, () => {
      const parsed = rows(opts);
      expect(parsed.length).toBe(N);
      for (const [value, flag] of parsed) {
        expect(flag === 'true' || flag === 'false', `flag must be boolean, got "${flag}"`).toBe(
          true,
        );
        // value >= 1000 iff it was spiked iff flag is "true"
        expect(flag, `value ${String(value)}`).toBe(value >= 1000 ? 'true' : 'false');
      }
    });

    it(`produces both true and false, ≈30% true (${label})`, () => {
      const trues = rows(opts).filter(([, f]) => f === 'true').length;
      expect(trues, label).toBeGreaterThan(90); // ≈ 150 of 500
      expect(trues, label).toBeLessThan(220);
    });
  }
});

describe('anomaly_flag on an inline type (text) marks exactly the spiked rows', () => {
  // type="text" numeric values take the inline streaming path (seekable #anom
  // draw), distinct from type="number" above — both must flag correctly.
  const textDoc =
    `<tdc><env count="500" seed="af" inject="\${{%}}">` +
    `<sequence name="V">` +
    `<gen type="text" value="1,2,3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag"/>` +
    `</sequence></env>` +
    `<block><line><data>\${{V}}|\${{Flag}}</data></line></block></tdc>`;
  for (const [label, opts] of ENGINES) {
    it(`flag matches the spike on every row (${label})`, () => {
      const parsed = render(parseStrict(textDoc), opts)
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [v, f] = l.split('|');
          return [Number(v), f ?? ''] as [number, string];
        });
      expect(parsed.length).toBe(N);
      for (const [value, flag] of parsed) {
        expect(flag, `value ${String(value)}`).toBe(value >= 1000 ? 'true' : 'false');
      }
    });
  }
});

describe('anomaly_flag validation (TDC193)', () => {
  const diags = (genBody: string) =>
    validate(
      parse(
        `<tdc><env count="5" seed="s"><sequence name="V">${genBody}</sequence></env>` +
          `<block><line><data>\${{V}}</data></line></block></tdc>`,
      ).tree,
    ).diagnostics;

  it('errors when anomaly_flag has no anomaly to flag', () => {
    const d = diags('<gen type="number" value="1..9" anomaly_flag="Flag"/>');
    expect(d.find((x) => x.code === 'TDC193')).toBeDefined();
  });

  it('errors when anomaly_flag is empty', () => {
    const d = diags('<gen type="number" value="1..9" anomaly="0.2" anomaly_flag=""/>');
    expect(d.find((x) => x.code === 'TDC193')).toBeDefined();
  });

  it('accepts anomaly_flag alongside anomaly', () => {
    const d = diags('<gen type="number" value="1..9" anomaly="0.2" anomaly_flag="Flag"/>');
    expect(d.find((x) => x.code === 'TDC193')).toBeUndefined();
  });
});

describe('anomaly_flag drives if=', () => {
  // The flag is a "true"/"false" string, so it filters by truthiness like the
  // _first/_last builtins: `if="Flag"` keeps the anomalous rows.
  it('if="Flag" keeps only the spiked rows', () => {
    const cfg =
      `<tdc><env count="200" seed="af" inject="\${{%}}">` +
      `<sequence name="V">` +
      `<gen type="number" value="1..3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag"/>` +
      `</sequence></env>` +
      `<block><line if="Flag"><data>\${{V}}</data></line></block></tdc>`;
    const out = render(parseStrict(cfg), { now: NOW, mode: 'disk' }).split('\n').filter(Boolean);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((l) => Number(l) >= 1000)).toBe(true);
  });
});
