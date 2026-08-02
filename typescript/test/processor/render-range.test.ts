import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { renderStream } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

// Stream mode, with before/after fixtures and a block delimiter — everything
// that a range boundary could get wrong.
const DSL = `
  <tdc>
    <env count="20" seed="rng" inject="\${{%}}" mode="stream">
      <before><line><data>HEAD</data></line></before>
      <after><line><data>TAIL</data></line></after>
      <delimiter_block><line><data>---</data></line></delimiter_block>
      <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
      <sequence name="Id"><gen type="increment" value="1"/></sequence>
    </env>
    <block><line><data>\${{Id}}:\${{G}}</data></line></block>
  </tdc>`;

const full = (): string => [...renderStream(parseStrict(DSL), { now: NOW })].join('');
const range = (start: number, end: number): string =>
  [...renderStream(parseStrict(DSL), { now: NOW, range: { start, end } })].join('');

describe('renderStream — range rendering (parallel foundation)', () => {
  it('concatenating contiguous ranges reproduces the full output byte-for-byte', () => {
    const whole = full();
    const partitions: readonly (readonly [number, number])[][] = [
      [[0, 20]],
      [
        [0, 7],
        [7, 14],
        [14, 20],
      ],
      [
        [0, 1],
        [1, 19],
        [19, 20],
      ],
      [
        [0, 10],
        [10, 10],
        [10, 20],
      ], // an empty middle range must contribute nothing
      [
        [0, 3],
        [3, 6],
        [6, 9],
        [9, 12],
        [12, 15],
        [15, 18],
        [18, 20],
      ],
    ];
    for (const parts of partitions) {
      let concat = '';
      for (const [a, b] of parts) concat += range(a, b);
      expect(concat).toBe(whole);
    }
  });

  it('emits before only at start===0 and after only at end===count', () => {
    expect(range(0, 5)).toContain('HEAD');
    expect(range(0, 5)).not.toContain('TAIL');
    expect(range(15, 20)).toContain('TAIL');
    expect(range(15, 20)).not.toContain('HEAD');
    expect(range(5, 15)).not.toContain('HEAD');
    expect(range(5, 15)).not.toContain('TAIL');
  });

  it('clamps an over-long end back to count (== full render)', () => {
    expect(
      [...renderStream(parseStrict(DSL), { now: NOW, range: { start: 0, end: 999 } })].join(''),
    ).toBe(full());
  });
});
