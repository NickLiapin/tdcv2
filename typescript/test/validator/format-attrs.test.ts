import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/index.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function diags(gen: string): Diagnostic[] {
  const src = `<tdc><env count="2"><sequence name="s">${gen}</sequence></env><block><line><data>_</data></line></block></tdc>`;
  return [...validate(parse(src).tree).diagnostics];
}
const codes = (d: Diagnostic[]): string[] => d.map((x) => x.code ?? '');

describe('validator — case/order attributes', () => {
  it('accepts valid case and order values', () => {
    expect(
      codes(diags('<gen type="text" value="a,b" case="upper" order="sequential"/>')),
    ).not.toContain('TDC190');
    expect(codes(diags('<gen type="text" value="a,b" case="title"/>'))).toEqual([]);
  });

  it('TDC190 on an unknown case', () => {
    expect(codes(diags('<gen type="text" value="a" case="sideways"/>'))).toContain('TDC190');
  });

  it('TDC199 on a malformed mask index, before anything renders', () => {
    // The hyphen is the likely habit; without this it would pass through as
    // literal text and quietly produce wrong data.
    expect(codes(diags('<gen type="text" value="ABC" mask="x[1-2]"/>'))).toContain('TDC199');
    expect(codes(diags('<gen type="text" value="ABC" mask="w[abc]"/>'))).toContain('TDC199');
  });

  it('accepts a well-formed mask index', () => {
    expect(codes(diags('<gen type="text" value="a b" mask="w[-1], w[0]"/>'))).not.toContain(
      'TDC199',
    );
    expect(codes(diags('<gen type="text" value="ABC" mask="x[0..1]-*"/>'))).not.toContain('TDC199');
    // A bracket that is not an index is still ordinary literal text.
    expect(codes(diags('<gen type="text" value="ABC" mask="[tel.] xxx"/>'))).not.toContain(
      'TDC199',
    );
  });

  it('TDC191 on an unknown order', () => {
    expect(codes(diags('<gen type="text" value="a" order="shuffled"/>'))).toContain('TDC191');
  });
});

describe('validator — interpolation filters', () => {
  function dataDiags(dataText: string): string[] {
    const src = `<tdc><env count="2"><sequence name="C"><gen type="text" value="a"/></sequence></env><block><line><data>${dataText}</data></line></block></tdc>`;
    return validate(parse(src).tree).diagnostics.map((d) => d.code ?? '');
  }

  it('accepts known filters', () => {
    expect(dataDiags('${{C | upper}}')).not.toContain('TDC192');
    expect(dataDiags('${{C | mask:xxx | lower}}')).not.toContain('TDC192');
    expect(dataDiags('${{C}}')).toEqual([]);
  });

  it('TDC192 on an unknown filter', () => {
    expect(dataDiags('${{C | uppper}}')).toContain('TDC192');
  });
});
