import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function run(source: string) {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return validate(result.tree);
}

const wrap = (body: string) =>
  `<tdc><env><sequence name="s">${body}</sequence></env><block><line><data>_</data></line></block></tdc>`;

/**
 * `<gen type="symbol">` accepts an inline character set via `value`
 * (literals + `[x-y]` ranges) as an alternative to a named `alphabet`.
 */
describe('validator — symbol inline value set', () => {
  it('accepts an inline literal set', () => {
    const r = run(wrap('<gen type="symbol" value="кхгд" length="2"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts an inline range set', () => {
    const r = run(wrap('<gen type="symbol" value="[a-z][0-9]" length="4"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors when both value and alphabet are given (TDC098)', () => {
    const r = run(wrap('<gen type="symbol" value="ab" alphabet="latin.lower" length="1"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC098')).toBeDefined();
  });

  it('errors on an unterminated range (TDC099)', () => {
    const r = run(wrap('<gen type="symbol" value="[a-z" length="1"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC099')).toBeDefined();
  });

  it('errors on a reversed range (TDC099)', () => {
    const r = run(wrap('<gen type="symbol" value="[z-a]" length="1"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC099')).toBeDefined();
  });

  it('still errors when neither value nor alphabet is given (TDC098)', () => {
    const r = run(wrap('<gen type="symbol" length="4"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC098')).toBeDefined();
  });

  it('accepts include/exclude modifiers', () => {
    const r = run(
      wrap('<gen type="symbol" alphabet="latin.lower" include="[0-9]" exclude="y" length="2"/>'),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on a malformed exclude (TDC099)', () => {
    const r = run(wrap('<gen type="symbol" value="[a-z]" exclude="[z-a]" length="1"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC099')).toBeDefined();
  });

  it('errors when include/exclude empty the set (TDC099)', () => {
    const r = run(wrap('<gen type="symbol" value="ab" exclude="ab" length="1"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC099')).toBeDefined();
  });
});
