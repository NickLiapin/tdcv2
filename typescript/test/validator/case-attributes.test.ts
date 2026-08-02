import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function run(source: string) {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return validate(result.tree);
}

// Wrap a list of <case>s in a named env-level <mix> and reference it.
const wrap = (cases: string) =>
  `<tdc><env count="4" seed="case-attr"><mix name="M">${cases}</mix></env>` +
  `<block><line><data>\${{M}}</data></line></block></tdc>`;

/**
 * `<mix>` distributes its `<case>` children across rows by percentage
 * (Hamilton), NOT by condition. Conditional attributes on `<case>` were
 * previously accepted and silently ignored — a trap that produces
 * plausible-but-wrong data. The validator now flags them (TDC128).
 */
describe('validator — <case> conditional-attribute trap', () => {
  it('errors on `if` on a <case> (TDC128)', () => {
    const r = run(wrap('<case if="_first"><data>A</data></case>' + '<case><data>B</data></case>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC128');
    expect(err).toBeDefined();
    expect(err?.severity).toBe('error');
    expect(err?.message).toMatch(/not supported/);
  });

  it('errors on `default` on a <case> (TDC128)', () => {
    const r = run(
      wrap('<case default="true"><data>A</data></case>' + '<case><data>B</data></case>'),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC128')).toBeDefined();
  });

  it('reports both `if` and `default` when both are present', () => {
    const r = run(
      wrap(
        '<case if="_first" default="true"><data>A</data></case>' + '<case><data>B</data></case>',
      ),
    );
    expect(r.diagnostics.filter((d) => d.code === 'TDC128')).toHaveLength(2);
  });

  it('accepts a plain <case> with only the comment attribute', () => {
    const r = run(
      wrap('<case comment="rare"><data>A</data></case>' + '<case><data>B</data></case>'),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });
});
