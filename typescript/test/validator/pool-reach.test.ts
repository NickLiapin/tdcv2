/**
 * The two pool checks that were reserved and then left out.
 *
 * `TDC231` is the cheap one: a pool is computed in full before the first row and
 * held for the whole run, so one nothing reads is paid for and thrown away.
 *
 * `TDC225` is the one the pool notes recorded as "not possible at check time".
 * It is, for the shape that matters: when the member's field and the other side
 * of a simple equality each draw from a list the config writes down, and the two
 * lists do not meet, the filter narrows every row to no member — which the run
 * discovers on row one, after building the pool.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function codes(source: string): string[] {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return validate(result.tree).diagnostics.map((d) => d.code ?? '?');
}

const POOL =
  '<pool name="D" count="3"><sequence name="c"><gen type="text" value="A,B"/></sequence></pool>';

const wrap = (env: string, data = '${{R.c}}') =>
  `<tdc><env count="4" seed="pl" local="en">${env}</env>` +
  `<block><line><data>${data}</data></line></block></tdc>`;

describe('validator — a pool nobody reads (TDC231)', () => {
  it('warns about a pool with no reference', () => {
    expect(codes(wrap(POOL, 'x'))).toEqual(['TDC231']);
  });

  it('says nothing once something draws from it', () => {
    expect(
      codes(wrap(`${POOL}<sequence name="R"><gen type="pool" value="D"/></sequence>`)),
    ).toEqual([]);
  });

  it('counts a reference that stands ABOVE the pool it names', () => {
    expect(
      codes(wrap(`<sequence name="R"><gen type="pool" value="D"/></sequence>${POOL}`)),
    ).toEqual([]);
  });
});

describe('validator — a filter that can never match (TDC225)', () => {
  it('refuses two lists that do not meet', () => {
    expect(
      codes(
        wrap(
          `${POOL}<sequence name="W"><gen type="text" value="Y,Z"/></sequence>` +
            '<sequence name="R"><gen type="pool" value="D" filter="c == W"/></sequence>',
        ),
      ),
    ).toEqual(['TDC225']);
  });

  it('refuses a bare word no member could hold', () => {
    expect(
      codes(
        wrap(
          `${POOL}<sequence name="R"><gen type="pool" value="D" filter="c == North"/></sequence>`,
        ),
      ),
    ).toEqual(['TDC225']);
  });

  it('says nothing when the lists overlap, however little', () => {
    expect(
      codes(
        wrap(
          `${POOL}<sequence name="W"><gen type="text" value="A,Z"/></sequence>` +
            '<sequence name="R"><gen type="pool" value="D" filter="c == W"/></sequence>',
        ),
      ),
    ).toEqual([]);
  });

  it('reaches a column declared BELOW the reference', () => {
    expect(
      codes(
        wrap(
          `${POOL}<sequence name="R"><gen type="pool" value="D" filter="c == W"/></sequence>` +
            '<sequence name="W"><gen type="text" value="Y,Z"/></sequence>',
        ),
      ),
    ).toEqual(['TDC225']);
  });

  it("stands down when the member's values are not written in the config", () => {
    const templated =
      '<pool name="D" count="3"><sequence name="c">' +
      '<gen type="template" value="person.lastName"/></sequence></pool>';
    expect(
      codes(
        wrap(
          `${templated}<sequence name="W"><gen type="text" value="Y,Z"/></sequence>` +
            '<sequence name="R"><gen type="pool" value="D" filter="c == W"/></sequence>',
        ),
      ),
    ).toEqual([]);
  });
});
