/**
 * Attributes that sat on a pool reference doing nothing.
 *
 * `<gen type="pool">` hands the row a whole MEMBER, drawn from a table built
 * before the run. It has no value of its own for the formatting layer to reach
 * and no column of its own to draw without replacement — so every one of these
 * was accepted, ignored, and reported valid.
 *
 * Measured before, six rows over a four-member pool. Plain, `case="upper"`,
 * `mask="xxxx"`, `missing="0.5"`, `percent="90,10"`, `anomaly="0.5"` and
 * `uniq="true"` all produced the same six values:
 *
 *     [Smith] [Brown] [Brown] [Brown] [Williams] [Williams]
 *
 * `missing=` is the sharpest of them: the pools guide tells the reader to use
 * `parent=` "to leave some rows without a member", and the other obvious reach
 * produced no gaps at all.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/parse.js';
import { validate } from '../../src/validator/validate.js';

function codes(config: string): string[] {
  const parsed = parse(config);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
}

function config(genAttrs: string, seqAttrs = ''): string {
  return (
    '<tdc><env count="6" seed="ab" local="en">' +
    '<pool name="Doctors" count="4">' +
    '<sequence name="name"><gen type="template" value="person.lastName"/></sequence>' +
    '</pool>' +
    `<sequence name="Seen"${seqAttrs}><gen type="pool" value="Doctors"${genAttrs}/></sequence>` +
    '</env><block><line><data>${{Seen.name}}</data></line></block></tdc>'
  );
}

describe('a pool reference and the attributes it cannot read', () => {
  it('accepts the plain reference', () => {
    expect(codes(config(''))).toEqual([]);
  });

  it.each([
    ['case', ' case="upper"'],
    ['mask', ' mask="xxxx"'],
    ['missing', ' missing="0.5"'],
    ['missing_as', ' missing="0.5" missing_as="NA"'],
    ['repeat', ' repeat="3"'],
    ['anomaly', ' anomaly="0.5"'],
    ['percent', ' percent="90,10"'],
  ])('refuses %s with TDC015', (_name, attr) => {
    expect(codes(config(attr))).toContain('TDC015');
  });

  it('refuses uniq="true" on the sequence with TDC218', () => {
    // Not TDC015: the attribute belongs on a <sequence>, it just cannot mean
    // anything on THIS one. The message points at uniq= inside the <pool>.
    expect(codes(config('', ' uniq="true"'))).toContain('TDC218');
  });

  it('still allows uniq= on a sequence INSIDE the pool', () => {
    const inside =
      '<tdc><env count="4" seed="ab" local="en">' +
      '<pool name="Doctors" count="4">' +
      '<sequence name="name" uniq="true"><gen type="template" value="person.lastName"/></sequence>' +
      '</pool>' +
      '<sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>' +
      '</env><block><line><data>${{Seen.name}}</data></line></block></tdc>';
    expect(codes(inside)).toEqual([]);
  });
});
