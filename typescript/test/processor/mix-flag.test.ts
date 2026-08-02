/**
 * `<mix flag="NAME">` + `<case anomaly="true">` — ground-truth companion column
 * marking which rows came from a branch declared anomalous.
 *
 * This closes the gap left by `anomaly_flag=`: that one labels only the
 * multiply-by-a-factor injection, so outliers modelled as a rare `<mix>` branch
 * — the natural way to say "usually 50..65, once in a while 120" — were
 * unlabelled and therefore useless as a scoring target.
 *
 * The flag must agree with the value on EVERY row in EVERY engine; a label that
 * is right on average is not ground truth.
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const N = 500;

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

// Two disjoint ranges, so "which branch produced this" is readable from the
// value alone: normal is 50..65, the marked branch is 118..122.
const doc =
  `<tdc><env count="${String(N)}" seed="mf" inject="\${{%}}">` +
  `<mix name="Reading" percent="80,20" flag="Bad">` +
  `<case><gen type="number" value="50..65"/></case>` +
  `<case anomaly="true"><gen type="number" value="118..122"/></case>` +
  `</mix></env>` +
  `<block><line><data>\${{Reading}}|\${{Bad}}</data></line></block></tdc>`;

const rows = (opts: RenderOptions): [number, string][] =>
  render(parseStrict(doc), opts)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [v, f] = l.split('|');
      return [Number(v), f ?? ''];
    });

describe('<mix flag> marks exactly the rows from the anomalous branch', () => {
  for (const [label, opts] of ENGINES) {
    it(`flag matches the branch on every row (${label})`, () => {
      const parsed = rows(opts);
      expect(parsed.length).toBe(N);
      for (const [value, flag] of parsed) {
        expect(flag === 'true' || flag === 'false', `flag must be boolean, got "${flag}"`).toBe(
          true,
        );
        expect(flag, `value ${String(value)}`).toBe(value >= 100 ? 'true' : 'false');
      }
    });

    it(`hits the declared percentage exactly (${label})`, () => {
      // <mix> distributes by exact quota, not by per-row coin flips, so 20% of
      // 500 is exactly 100 — no statistical slack needed.
      expect(rows(opts).filter(([, f]) => f === 'true').length, label).toBe(100);
    });
  }

  it('an unmarked mix still works and needs no flag', () => {
    const plain =
      `<tdc><env count="10" seed="mf2" inject="\${{%}}">` +
      `<mix name="M" percent="50,50">` +
      `<case><gen type="text" value="A"/></case>` +
      `<case><gen type="text" value="B"/></case>` +
      `</mix></env>` +
      `<block><line><data>\${{M}}</data></line></block></tdc>`;
    const out = render(parseStrict(plain), { now: NOW, mode: 'memory' });
    expect(out.split('\n').filter(Boolean)).toHaveLength(10);
  });

  it('marking no case yields an all-false column (still a valid label)', () => {
    const none =
      `<tdc><env count="20" seed="mf3" inject="\${{%}}">` +
      `<mix name="M" percent="50,50" flag="F">` +
      `<case><gen type="text" value="A"/></case>` +
      `<case><gen type="text" value="B"/></case>` +
      `</mix></env>` +
      `<block><line><data>\${{F}}</data></line></block></tdc>`;
    const out = render(parseStrict(none), { now: NOW, mode: 'memory' }).split('\n').filter(Boolean);
    expect(new Set(out)).toEqual(new Set(['false']));
  });
});
