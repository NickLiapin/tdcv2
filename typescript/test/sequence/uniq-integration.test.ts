import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { parse, parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { validate } from '../../src/validator/validate.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Integration tests for `uniq="true"` on a compound sequence — the tuple of
 * fields is unique across every row. Full pipeline (parse → build → render).
 */
describe('uniq="true" on a compound sequence', () => {
  it('produces all-distinct tuples when feasible', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="uniq-ok" inject="\${{%}}">
          <sequence name="P" uniq="true">
            <gen name="a" type="text" value="x,y,z" percent="34,33,33"/>
            <gen name="b" type="text" value="m,n" percent="50,50"/>
          </sequence>
        </env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: FIXED_NOW }).split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(new Set(lines).size).toBe(6); // every combination unique
  });

  it('is deterministic across runs', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="uniq-det" inject="\${{%}}">
          <sequence name="P" uniq="true">
            <gen name="a" type="text" value="x,y,z" percent="34,33,33"/>
            <gen name="b" type="text" value="m,n" percent="50,50"/>
          </sequence>
        </env>
        <block><line><data>\${{P.a}}-\${{P.b}}</data></line></block>
      </tdc>`;
    const a = render(parseStrict(dsl), { now: FIXED_NOW });
    const b = render(parseStrict(dsl), { now: FIXED_NOW });
    expect(a).toBe(b);
  });

  it('preserves each field percentage (multisets untouched by uniq)', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="uniq-pct" inject="\${{%}}">
          <sequence name="P" uniq="true">
            <gen name="a" type="text" value="x,y,z" percent="34,33,33"/>
            <gen name="b" type="text" value="m,n" percent="50,50"/>
          </sequence>
        </env>
        <block><line><data>\${{P.a}}|\${{P.b}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: FIXED_NOW }).split('\n').filter(Boolean);
    const countOf = (col: number, v: string): number =>
      lines.filter((l) => l.split('|')[col] === v).length;
    // Hamilton pins a → 2/2/2 and b → 3/3; uniq only rearranged them.
    expect([countOf(0, 'x'), countOf(0, 'y'), countOf(0, 'z')]).toEqual([2, 2, 2]);
    expect([countOf(1, 'm'), countOf(1, 'n')]).toEqual([3, 3]);
    expect(new Set(lines).size).toBe(6);
  });

  it('errors before output when uniqueness is impossible', () => {
    // 2×2 = 4 possible combinations, but 5 rows requested.
    const dsl = `
      <tdc>
        <env count="5" seed="uniq-bad" inject="\${{%}}">
          <sequence name="P" uniq="true">
            <gen name="a" type="text" value="x,y"/>
            <gen name="b" type="text" value="m,n"/>
          </sequence>
        </env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(dsl), { now: FIXED_NOW })).toThrow(/uniq/i);
  });

  it('is accepted end-to-end by the TDC class (validator included)', () => {
    const config = `<tdc>
      <env count="4" seed="uniq-tdc" inject="\${{%}}">
        <sequence name="P" uniq="true">
          <gen name="a" type="text" value="x,y" percent="50,50"/>
          <gen name="b" type="text" value="m,n" percent="50,50"/>
        </sequence>
      </env>
      <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
    </tdc>`;
    const lines = new TDC({ configString: config, now: FIXED_NOW })
      .toString()
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(new Set(lines).size).toBe(4);
  });
});

/** Form B — <uniq> wrapping separate sequences (env level). */
describe('<uniq> around separate sequences', () => {
  it('makes the tuple of the wrapped sequences unique across rows', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="env-uniq" inject="\${{%}}">
          <uniq>
            <sequence name="A"><gen type="text" value="x,y,z" percent="34,33,33"/></sequence>
            <sequence name="B"><gen type="text" value="m,n" percent="50,50"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}\${{B}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: FIXED_NOW }).split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(new Set(lines).size).toBe(6);
  });

  it('errors before output when the combined tuple cannot be unique', () => {
    const dsl = `
      <tdc>
        <env count="5" seed="env-uniq-bad" inject="\${{%}}">
          <uniq>
            <sequence name="A"><gen type="text" value="x,y" percent="50,50"/></sequence>
            <sequence name="B"><gen type="text" value="m,n" percent="50,50"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}\${{B}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(dsl), { now: FIXED_NOW })).toThrow(/uniq/i);
  });

  it('rejects a compound sequence inside <uniq> (validator)', () => {
    const dsl = `
      <tdc>
        <env count="3" seed="env-uniq-compound" inject="\${{%}}">
          <uniq>
            <sequence name="P">
              <gen name="a" type="text" value="x,y"/>
              <gen name="b" type="text" value="m,n"/>
            </sequence>
            <sequence name="Q"><gen type="text" value="x,y"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{Q}}</data></line></block>
      </tdc>`;
    const { diagnostics } = validate(parse(dsl).tree);
    expect(diagnostics.some((d) => /must produce a single value/i.test(d.message))).toBe(true);
  });
});
