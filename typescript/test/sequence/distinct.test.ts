import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parse, parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { validate } from '../../src/validator/validate.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Integration tests for the <distinct> tag — grouped compound fields that
 * must produce different values from each other within a single row.
 *
 * Full pipeline (parser → validator → build → render), since distinct
 * semantics live in extraction + materialization and cross those layers.
 */

function distinctPair(seed: string, count: number, values: string): string {
  return `
    <tdc>
      <env count="${String(count)}" seed="${seed}" inject="\${{%}}">
        <sequence name="P">
          <distinct>
            <gen name="A" type="text" value="${values}"/>
            <gen name="B" type="text" value="${values}"/>
          </distinct>
        </sequence>
      </env>
      <block>
        <line><data>\${{P.A}}|\${{P.B}}</data></line>
      </block>
    </tdc>`;
}

describe('<distinct> — no repeats within a row', () => {
  it('two fields from the same 2-value list never coincide in a row', () => {
    const out = render(parseStrict(distinctPair('distinct-1', 40, 'X,Y')), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(40);
    for (const line of lines) {
      const [a, b] = line.split('|');
      expect(a).not.toBe(b); // never X|X or Y|Y
      expect(['X', 'Y']).toContain(a);
      expect(['X', 'Y']).toContain(b);
    }
  });

  it('is deterministic across runs', () => {
    const a = render(parseStrict(distinctPair('distinct-det', 30, 'a,b,c,d')), { now: FIXED_NOW });
    const b = render(parseStrict(distinctPair('distinct-det', 30, 'a,b,c,d')), { now: FIXED_NOW });
    expect(a).toBe(b);
  });

  it('two independent <distinct> groups each hold within a row', () => {
    const dsl = `
      <tdc>
        <env count="25" seed="distinct-2grp" inject="\${{%}}">
          <sequence name="P">
            <distinct>
              <gen name="F1" type="text" value="p,q"/>
              <gen name="F2" type="text" value="p,q"/>
            </distinct>
            <distinct>
              <gen name="L1" type="text" value="m,n"/>
              <gen name="L2" type="text" value="m,n"/>
            </distinct>
          </sequence>
        </env>
        <block>
          <line><data>\${{P.F1}}\${{P.F2}} \${{P.L1}}\${{P.L2}}</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(25);
    for (const line of lines) {
      const [names, surnames] = line.split(' ');
      expect(names?.[0]).not.toBe(names?.[1]); // F1 != F2
      expect(surnames?.[0]).not.toBe(surnames?.[1]); // L1 != L2
    }
  });

  it('a field OUTSIDE the group is left unconstrained', () => {
    // C shares the same list but is not in <distinct>, so it may equal A or B.
    const dsl = `
      <tdc>
        <env count="10" seed="distinct-mixed" inject="\${{%}}">
          <sequence name="P">
            <distinct>
              <gen name="A" type="text" value="X,Y"/>
              <gen name="B" type="text" value="X,Y"/>
            </distinct>
            <gen name="C" type="text" value="X,Y"/>
          </sequence>
        </env>
        <block>
          <line><data>\${{P.A}}\${{P.B}}\${{P.C}}</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    for (const line of out.split('\n').filter(Boolean)) {
      expect(line[0]).not.toBe(line[1]); // A != B always
      expect(['X', 'Y']).toContain(line[2]); // C valid, unconstrained
    }
  });

  it('throws a clear error when a source cannot satisfy distinctness', () => {
    // One-value list but two fields must differ → impossible → fuse fires.
    expect(() =>
      render(parseStrict(distinctPair('distinct-fuse', 5, 'ONLY')), { now: FIXED_NOW }),
    ).toThrow(/distinct/i);
  });
});

/**
 * Config-level <distinct>: wraps whole <sequence>s in <env> so that fields
 * living in SEPARATE sequences (possibly from different files) differ per
 * row — e.g. city of birth != city of residence.
 */
function twoSeq(seed: string, count: number, list: string): string {
  return `
    <tdc>
      <env count="${String(count)}" seed="${seed}" inject="\${{%}}">
        <distinct>
          <sequence name="Birth"><gen type="text" value="${list}"/></sequence>
          <sequence name="Live"><gen type="text" value="${list}"/></sequence>
        </distinct>
      </env>
      <block>
        <line><data>\${{Birth}}|\${{Live}}</data></line>
      </block>
    </tdc>`;
}

describe('<distinct> at config level — around whole sequences', () => {
  it('two sequences from the same list never coincide in a row', () => {
    const out = render(parseStrict(twoSeq('cfg-distinct-1', 40, 'A,B')), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(40);
    for (const line of lines) {
      const [birth, live] = line.split('|');
      expect(birth).not.toBe(live);
      expect(['A', 'B']).toContain(birth);
      expect(['A', 'B']).toContain(live);
    }
  });

  it('catches collisions across two DIFFERENT lists that share a value', () => {
    // Both lists contain "Madrid"; whenever both draw it, one is redrawn.
    const dsl = `
      <tdc>
        <env count="30" seed="cfg-crossfile" inject="\${{%}}">
          <distinct>
            <sequence name="Birth"><gen type="text" value="Madrid,Sevilla"/></sequence>
            <sequence name="Live"><gen type="text" value="Madrid,Bilbao"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{Birth}}|\${{Live}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    for (const line of out.split('\n').filter(Boolean)) {
      const [birth, live] = line.split('|');
      expect(birth).not.toBe(live); // never Madrid|Madrid
    }
  });

  it('is deterministic across runs', () => {
    const a = render(parseStrict(twoSeq('cfg-det', 30, 'a,b,c,d')), { now: FIXED_NOW });
    const b = render(parseStrict(twoSeq('cfg-det', 30, 'a,b,c,d')), { now: FIXED_NOW });
    expect(a).toBe(b);
  });

  it('throws when the source is too small to satisfy distinctness', () => {
    expect(() => render(parseStrict(twoSeq('cfg-fuse', 5, 'ONLY')), { now: FIXED_NOW })).toThrow(
      /distinct/i,
    );
  });

  it('rejects a compound sequence inside a config-level <distinct>', () => {
    const dsl = `
      <tdc>
        <env count="3" seed="cfg-bad" inject="\${{%}}">
          <distinct>
            <sequence name="P">
              <gen name="a" type="text" value="X,Y"/>
              <gen name="b" type="text" value="X,Y"/>
            </sequence>
            <sequence name="Q"><gen type="text" value="X,Y"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{Q}}</data></line></block>
      </tdc>`;
    const { diagnostics } = validate(parse(dsl).tree);
    expect(hasErrors(diagnostics)).toBe(true);
    expect(diagnostics.some((d) => /distinct/i.test(d.message))).toBe(true);
  });
});
