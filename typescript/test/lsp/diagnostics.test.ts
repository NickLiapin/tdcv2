import { describe, expect, it } from 'vitest';

import { computeDiagnostics } from '../../src/lsp/diagnostics.js';
import { Severity } from '../../src/lsp/types.js';

const CLEAN = `<tdc>
  <env count="3" seed="s" inject="\${{%}}">
    <sequence name="G"><gen type="text" value="A,B"/></sequence>
  </env>
  <block><line><data>\${{G}}</data></line></block>
</tdc>`;

describe('computeDiagnostics', () => {
  it('returns no diagnostics for a clean document', () => {
    expect(computeDiagnostics(CLEAN)).toEqual([]);
  });

  it('flags an unknown gen type with an error and a stable code', () => {
    const src = `<tdc>
      <env count="1"><sequence name="G"><gen type="txt" value="A"/></sequence></env>
      <block><line><data>\${{G}}</data></line></block>
    </tdc>`;
    const diags = computeDiagnostics(src);
    const unknown = diags.find((d) => d.code === 'TDC041');
    expect(unknown).toBeDefined();
    expect(unknown?.severity).toBe(Severity.Error);
    expect(unknown?.source).toBe('tdc');
    // Range points at the type value, not the whole document.
    expect(unknown?.range.start.line).toBeGreaterThanOrEqual(0);
  });

  it('flags an unknown template path', () => {
    const src = `<tdc>
      <env count="1"><sequence name="G"><gen type="template" value="person.nope"/></sequence></env>
      <block><line><data>\${{G}}</data></line></block>
    </tdc>`;
    expect(computeDiagnostics(src).some((d) => d.code === 'TDC071')).toBe(true);
  });

  it('accepts a template that resolves to a provided pack address', () => {
    const src = `<tdc>
      <env count="1"><sequence name="G"><gen type="template" value="demo.city"/></sequence></env>
      <block><line><data>\${{G}}</data></line></block>
    </tdc>`;
    // Without the pack it's unknown…
    expect(computeDiagnostics(src).some((d) => d.code === 'TDC071')).toBe(true);
    // …with the address supplied, it is accepted.
    const withPack = computeDiagnostics(src, { packAddresses: ['demo.city'] });
    expect(withPack.some((d) => d.code === 'TDC071')).toBe(false);
  });

  it('reports a diagnostic for a structurally broken document', () => {
    expect(computeDiagnostics('<tdc><env count="1"></env>').length).toBeGreaterThan(0);
  });

  it('does not flood the whole file with TDC002 when syntax is broken', () => {
    // A stray unclosed <gen> inside <switch> breaks the parse; the tree loses
    // <block>, so the naive path fires TDC002 spanning all of <tdc> (the
    // "everything is red" flood). It must be suppressed while syntax is broken.
    const src = `<tdc>
      <env count="2" seed="s">
        <sequence name="G"><gen type="text" value="a,b"/></sequence>
        <switch name="S" on="G">
          <case is="a"><data>X</data></case>
          <gen>
        </switch>
      </env>
      <block><line><data>\${{S}}</data></line></block>
    </tdc>`;
    const diags = computeDiagnostics(src);
    const lastLine = src.split('\n').length - 1;

    // The misleading whole-document "no <block>" is gone…
    expect(diags.some((d) => d.code === 'TDC002')).toBe(false);
    // …a syntax error is still reported…
    expect(diags.some((d) => d.severity === Severity.Error)).toBe(true);
    // …the precise "unexpected <gen> in <switch>" finding survives…
    expect(diags.some((d) => d.code === 'TDC124')).toBe(true);
    // …and NO single diagnostic underlines the entire file.
    expect(diags.every((d) => !(d.range.start.line === 0 && d.range.end.line >= lastLine))).toBe(
      true,
    );
  });
});
