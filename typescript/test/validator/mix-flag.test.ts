/**
 * Validator for the `<mix flag>` / `<case anomaly="true">` ground-truth pair.
 *
 * Either half alone is silently useless — the config reads as if it labels
 * anomalies while the runtime does nothing. That is exactly the trap TDC128
 * was added for, so it gets the same treatment: surface it, don't ignore it.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function run(source: string) {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return validate(result.tree);
}

const wrap = (mixOpen: string, cases: string) =>
  // count is 20 rather than a token 4 so that `percent="80,20"` covers whole
  // rows. Below that the smaller share asks for less than one record and earns
  // TDC251, which has nothing to do with what these tests are about.
  `<tdc><env count="20" seed="mf">${mixOpen}${cases}</mix></env>` +
  `<block><line><data>\${{M}}</data></line></block></tdc>`;

const TWO_CASES =
  '<case><gen type="text" value="A"/></case><case><gen type="text" value="B"/></case>';

describe('validator — <mix flag> / <case anomaly>', () => {
  it('accepts the complete pair without complaint', () => {
    const r = run(
      wrap(
        '<mix name="M" percent="80,20" flag="Bad">',
        '<case><gen type="text" value="A"/></case>' +
          '<case anomaly="true"><gen type="text" value="B"/></case>',
      ),
    );
    expect(r.diagnostics).toEqual([]);
  });

  it('errors when a case is marked but the mix declares no flag (TDC203)', () => {
    const r = run(
      wrap(
        '<mix name="M" percent="80,20">',
        '<case><gen type="text" value="A"/></case>' +
          '<case anomaly="true"><gen type="text" value="B"/></case>',
      ),
    );
    const err = r.diagnostics.find((d) => d.code === 'TDC203');
    expect(err?.severity).toBe('error');
    expect(err?.message).toMatch(/does nothing/);
  });

  it('errors when a flag is declared but no case is marked (TDC202)', () => {
    const r = run(wrap('<mix name="M" percent="80,20" flag="Bad">', TWO_CASES));
    const warn = r.diagnostics.find((d) => d.code === 'TDC202');
    expect(warn?.severity).toBe('error');
    expect(warn?.message).toMatch(/all "false"/);
  });

  it('errors on flag= on a nested <mix> (TDC203)', () => {
    const src =
      `<tdc><env count="20" seed="mf">` +
      `<mix name="M" percent="50,50" flag="Bad">` +
      `<case anomaly="true"><gen type="text" value="A"/></case>` +
      `<case><mix percent="50,50" flag="Inner">` +
      `<case><gen type="text" value="B"/></case>` +
      `<case><gen type="text" value="C"/></case>` +
      `</mix></case>` +
      `</mix></env>` +
      `<block><line><data>\${{M}}</data></line></block></tdc>`;
    const err = run(src).diagnostics.find((d) => d.code === 'TDC203');
    expect(err?.severity).toBe('error');
    expect(err?.message).toMatch(/nested <mix>/);
  });

  it('leaves a plain mix with neither attribute alone', () => {
    expect(run(wrap('<mix name="M" percent="50,50">', TWO_CASES)).diagnostics).toEqual([]);
  });
});
