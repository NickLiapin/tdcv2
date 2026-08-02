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

describe('validator — number include/exclude', () => {
  it('accepts include/exclude on a numeric range', () => {
    const r = run(wrap('<gen type="number" value="0..100" exclude="40..60" include="200"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors when include/exclude used without a range (TDC087)', () => {
    const r = run(wrap('<gen type="number" exclude="3"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC087')).toBeDefined();
  });

  it('errors on a malformed exclude (TDC087)', () => {
    const r = run(wrap('<gen type="number" value="0..9" exclude="60..40"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC087')).toBeDefined();
  });

  it('errors when exclude empties the range (TDC087)', () => {
    const r = run(wrap('<gen type="number" value="0..2" exclude="0..2"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC087')).toBeDefined();
  });
});
