import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('<data if="..."> — conditional emission of raw-text regions', () => {
  it('emits the data text when the condition is truthy', () => {
    const dsl = `<tdc><env count="2" seed="x" inject="\${{%}}"></env><block><line><data if="_first">HEAD</data><data>row</data></line></block></tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    expect(out.split('\n')).toEqual(['HEADrow', 'row', '']);
  });

  it('suppresses the data text when the condition is falsy', () => {
    const dsl = `<tdc><env count="3" seed="x" inject="\${{%}}"></env><block><line><data if="!_last">,</data></line></block></tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    // Three iterations: first two emit ',', the last emits nothing on
    // that <data>. Line still emits its trailing newline.
    expect(out).toBe(',\n,\n\n');
  });

  it('works with numeric comparisons on _count', () => {
    const dsl =
      '<tdc><env count="5" seed="x" inject="${{%}}"></env>' +
      '<block><line><data>N=${{_count}}</data>' +
      '<data if="_count > 2">(big)</data></line></block></tdc>';
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['N=1', 'N=2', 'N=3(big)', 'N=4(big)', 'N=5(big)']);
  });

  it('<data> without if still works (back-compat with existing fixtures)', () => {
    const dsl = `<tdc><env count="2" seed="x"></env><block><line><data>hi</data></line></block></tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    expect(out).toBe('hi\nhi\n');
  });

  it('supports logical operators in the condition', () => {
    const dsl = `<tdc><env count="4" seed="x"></env><block><line><data>row </data><data if="_first || _last">[edge]</data></line></block></tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toEqual(['row [edge]', 'row ', 'row ', 'row [edge]']);
  });
});
