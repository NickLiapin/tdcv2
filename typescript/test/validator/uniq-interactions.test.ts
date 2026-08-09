/**
 * Three combinations the docs describe as free and the engine could not keep.
 *
 * Every "before" here was measured against the unfixed engine.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/parse.js';
import { validate } from '../../src/validator/validate.js';

function codes(config: string): string[] {
  const parsed = parse(config);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
}

const env = (body: string, count = 12): string =>
  `<tdc version="0.01"><env count="${String(count)}" seed="s1" local="en">${body}</env>` +
  '<block><line><data>x</data></line></block></tdc>';

describe('<distinct> inside a uniq="true" sequence', () => {
  it('is refused', () => {
    // Before: 12 rows over 12 legal distinct pairs still produced s,s and q,q —
    // the uniq rearrangement undid the repair, and `check` said valid.
    expect(
      codes(
        env(
          '<sequence name="Person" uniq="true"><distinct>' +
            '<gen name="A" type="text" value="p,q,r,s"/>' +
            '<gen name="B" type="text" value="p,q,r,s"/>' +
            '</distinct></sequence>',
        ),
      ),
    ).toContain('TDC267');
  });

  it('leaves <distinct> alone without uniq', () => {
    expect(
      codes(
        env(
          '<sequence name="Person"><distinct>' +
            '<gen name="A" type="text" value="p,q,r,s"/>' +
            '<gen name="B" type="text" value="p,q,r,s"/>' +
            '</distinct></sequence>',
        ),
      ),
    ).toEqual([]);
  });
});

describe('the formatting layer under uniq="true"', () => {
  it('is refused on a COMPOUND sequence, not only a simple one', () => {
    // Before: missing="0.4" over 12 rows produced ZERO blanks, in silence.
    expect(
      codes(
        env(
          '<sequence name="Person" uniq="true">' +
            '<gen name="A" type="text" value="p,q,r,s" missing="0.4"/>' +
            '<gen name="B" type="text" value="1,2,3,4"/>' +
            '</sequence>',
        ),
      ),
    ).toContain('TDC267');
  });

  it('still accepts a compound uniq that asks for nothing extra', () => {
    expect(
      codes(
        env(
          '<sequence name="Person" uniq="true">' +
            '<gen name="A" type="text" value="p,q,r,s"/>' +
            '<gen name="B" type="text" value="1,2,3,4"/>' +
            '</sequence>',
        ),
      ),
    ).toEqual([]);
  });
});

describe('order="sequential" on part of a row= link', () => {
  const link = (secondOrder: string): string =>
    env(
      '<sequence name="U">' +
        '<gen name="F" type="file" src="users.csv" column="first_name" row="u" order="sequential"/>' +
        `<gen name="L" type="file" src="users.csv" column="last_name" row="u"${secondOrder}/>` +
        '</sequence>',
      6,
    );

  it('is refused when the members disagree', () => {
    // Before: John was paired with Johnson — John's last name is Smith. That is
    // exactly the drift row= exists to prevent, and `check` said valid.
    expect(codes(link(''))).toContain('TDC282');
  });

  it('is allowed when every member walks in step', () => {
    // Both rules then pick by position, so the records hold — measured.
    expect(codes(link(' order="sequential"'))).not.toContain('TDC282');
  });
});
