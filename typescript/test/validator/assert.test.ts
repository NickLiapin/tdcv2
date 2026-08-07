/**
 * TDC265 / TDC266 — the two attributes `<assert>` cannot do without.
 *
 * An assertion is the one construct whose whole worth is that it FAILS, so a
 * half-written one is worse than none: the config carries a check, the reader
 * believes the run was verified, and nothing was ever compared.
 *
 * The expression is deliberately NOT re-checked here — `that=` is the `if=`
 * language, so a typo in a column name comes out of the same put-aside pass that
 * catches it in `if=`, and the last test pins that it really does.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const codes = (body: string): string[] => {
  const source =
    `<tdc><env count="10" seed="s" local="en">${body}</env>` +
    '<block><line><data>x</data></line></block></tdc>';
  const parsed = parse(source);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
};

const N = '<sequence name="N"><gen type="number" value="1..9"/></sequence>';
const ROWS = '<sequence name="Rows"><gen type="stat" of="N" op="count"/></sequence>';

describe('<assert> — the validator', () => {
  it('says nothing about a complete assertion', () => {
    expect(codes(`${N}${ROWS}<assert that="Rows == 10" says="every row is counted"/>`)).toEqual([]);
  });

  it('TDC265 — no condition at all', () => {
    expect(codes(`${N}${ROWS}<assert says="something"/>`)).toContain('TDC265');
  });

  it('TDC265 — a condition that is only whitespace', () => {
    expect(codes(`${N}${ROWS}<assert that="   " says="something"/>`)).toContain('TDC265');
  });

  it('TDC266 — a condition with nothing to tell the reader', () => {
    expect(codes(`${N}${ROWS}<assert that="Rows == 10"/>`)).toContain('TDC266');
  });

  it('reports the missing condition and stops, rather than complaining twice', () => {
    // With no expression there is nothing to name in the second message, and two
    // errors on one tag reads as two mistakes.
    expect(codes(`${N}${ROWS}<assert/>`)).toEqual(['TDC265']);
  });

  it('a typo in a column name is the same error it is in if=', () => {
    expect(codes(`${N}${ROWS}<assert that="Rowss == 10" says="…"/>`)).toContain('TDC215');
  });

  it('a broken expression is the same error it is in if=', () => {
    expect(codes(`${N}${ROWS}<assert that="Rows ==" says="…"/>`)).toContain('TDC100');
  });

  it('<assert> is allowed in <env> and nowhere else', () => {
    const inSequence =
      '<tdc><env count="10" seed="s" local="en">' +
      '<sequence name="N"><gen type="number" value="1..9"/><assert that="1 == 1" says="…"/></sequence>' +
      '</env><block><line><data>x</data></line></block></tdc>';
    expect(validate(parse(inSequence).tree).diagnostics.length).toBeGreaterThan(0);
  });
});
