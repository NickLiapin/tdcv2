import { describe, expect, it } from 'vitest';

import { evalExpr } from './helpers.js';

describe('encode', () => {
  it('base36 maps a letter to its decimal value', () => {
    expect(evalExpr('<encode as="base36"><str v="D"/></encode>')).toBe('13');
    expect(evalExpr('<encode as="base36"><str v="0"/></encode>')).toBe('0');
  });

  it('errors when given a multi-character string', () => {
    expect(() => evalExpr('<encode as="base36"><str v="AB"/></encode>')).toThrow(
      /single character/,
    );
  });
});

describe('to_number', () => {
  it('parses a multi-digit string field to an int usable in arithmetic', () => {
    expect(
      evalExpr('<add><to_number><field name="n"/></to_number><int v="1"/></add>', { n: '80' }),
    ).toBe('81');
  });

  it('errors on non-numeric input', () => {
    expect(() => evalExpr('<to_number><str v="1a"/></to_number>')).toThrow(/not a valid integer/);
  });
});

describe('pad', () => {
  it('left-pads to width with 0 by default', () => {
    expect(evalExpr('<pad width="4"><int v="7"/></pad>')).toBe('0007');
  });

  it('honours a custom fill', () => {
    expect(evalExpr('<pad width="3" fill="x"><str v="a"/></pad>')).toBe('xxa');
  });

  it('leaves a value already at width unchanged', () => {
    expect(evalExpr('<pad width="2"><int v="42"/></pad>')).toBe('42');
  });
});

describe('concat', () => {
  it('concatenates fields, ints, and literals in order', () => {
    expect(
      evalExpr('<concat><field name="a"/><str v="-"/><int v="42"/></concat>', { a: 'X' }),
    ).toBe('X-42');
  });

  it('empty concat is the empty string', () => {
    expect(evalExpr('<concat/>')).toBe('');
  });
});

describe('text formatting (upper/lower/capitalize/title/mask)', () => {
  it('case transforms', () => {
    expect(evalExpr('<upper><str v="abc"/></upper>')).toBe('ABC');
    expect(evalExpr('<lower><str v="ABC"/></lower>')).toBe('abc');
    expect(evalExpr('<capitalize><str v="иван"/></capitalize>')).toBe('Иван');
    expect(evalExpr('<title><str v="john dow"/></title>')).toBe('John Dow');
  });

  it('mask with pattern attribute', () => {
    expect(
      evalExpr('<mask pattern="xxx-xxx-xxx xx"><field name="s"/></mask>', { s: '11223344595' }),
    ).toBe('112-233-445 95');
    expect(evalExpr('<mask pattern="w:w"><str v="John Dow"/></mask>')).toBe('John:Dow');
  });

  it('formatting tags nest with each other and with other ops', () => {
    expect(evalExpr('<upper><mask pattern="w:w"><str v="john dow"/></mask></upper>')).toBe(
      'JOHN:DOW',
    );
  });

  it('slice / replace / trim / group', () => {
    expect(evalExpr('<slice from="1" to="4"><str v="abcdef"/></slice>')).toBe('bcd');
    expect(evalExpr('<replace from="-" to="/"><str v="a-b-c"/></replace>')).toBe('a/b/c');
    expect(evalExpr('<trim><str v="  hi  "/></trim>')).toBe('hi');
    expect(evalExpr('<group size="3" sep=" "><str v="1234567"/></group>')).toBe('1 234 567');
  });
});

describe('choose / when / otherwise', () => {
  const cmp = (a: string, b: string): string =>
    evalExpr(
      '<choose>' +
        '<when><test><greater_than><field name="a"/><field name="b"/></greater_than></test>' +
        '<then><str v="gt"/></then></when>' +
        '<when><test><less_than><field name="a"/><field name="b"/></less_than></test>' +
        '<then><str v="lt"/></then></when>' +
        '<otherwise><str v="eq"/></otherwise>' +
        '</choose>',
      { a, b },
    );

  it('selects the first matching branch', () => {
    expect(cmp('9', '1')).toBe('gt');
    expect(cmp('1', '9')).toBe('lt');
  });

  it('falls through to otherwise', () => {
    expect(cmp('5', '5')).toBe('eq');
  });

  it('errors when nothing matches and there is no otherwise', () => {
    expect(() =>
      evalExpr(
        '<choose><when><test><equals><int v="1"/><int v="2"/></equals></test>' +
          '<then><int v="0"/></then></when></choose>',
      ),
    ).toThrow(/no <otherwise>/);
  });
});

describe('predicates', () => {
  it('equals', () => {
    expect(
      evalExpr(
        '<choose><when><test><equals><int v="3"/><int v="3"/></equals></test>' +
          '<then><str v="y"/></then></when><otherwise><str v="n"/></otherwise></choose>',
      ),
    ).toBe('y');
  });

  it('is_digit true/false', () => {
    const isDigit = (s: string): string =>
      evalExpr(
        '<choose><when><test><is_digit><field name="c"/></is_digit></test>' +
          '<then><str v="yes"/></then></when><otherwise><str v="no"/></otherwise></choose>',
        { c: s },
      );
    expect(isDigit('5')).toBe('yes');
    expect(isDigit('A')).toBe('no');
  });
});
