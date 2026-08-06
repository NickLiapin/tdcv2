import { describe, expect, it } from 'vitest';

import { evalExpr } from './helpers.js';

describe('literals', () => {
  it('int', () => {
    expect(evalExpr('<int v="42"/>')).toBe('42');
    expect(evalExpr('<int v="-7"/>')).toBe('-7');
  });

  it('str', () => {
    expect(evalExpr('<str v="hello"/>')).toBe('hello');
    expect(evalExpr('<str v=""/>')).toBe('');
  });

  it('rejects a malformed int literal', () => {
    expect(() => evalExpr('<int v="1a"/>')).toThrow(/not an integer/);
  });
});

describe('field references', () => {
  it('reads a field value', () => {
    expect(evalExpr('<field name="x"/>', { x: 'abc' })).toBe('abc');
  });

  it('errors on an unknown field', () => {
    expect(() => evalExpr('<field name="missing"/>')).toThrow(/not in scope/);
  });

  // The row counters are numbers, not text. They used to arrive as strings, and
  // `coerceInt` lets a SINGLE digit through — so `<mod><field name="_count"/>…`
  // worked to row 9 and threw on row 10. A config proven on five rows broke on
  // a million, which is the worst shape this kind of bug can take.
  it('reads _count and _total as integers, at any magnitude', () => {
    expect(evalExpr('<mod><field name="_count"/><int v="2"/></mod>', { _count: '10' })).toBe('0');
    expect(evalExpr('<mod><field name="_count"/><int v="2"/></mod>', { _count: '9' })).toBe('1');
    expect(evalExpr('<add><field name="_total"/><int v="1"/></add>', { _total: '1000000' })).toBe(
      '1000001',
    );
  });

  it('leaves _first and _last as the strings they are', () => {
    expect(evalExpr('<field name="_last"/>', { _last: 'true' })).toBe('true');
    expect(() =>
      evalExpr('<add><field name="_last"/><int v="1"/></add>', { _last: 'true' }),
    ).toThrow(/expected an integer/);
  });

  it('an ordinary field is still text, so its digits stay characters', () => {
    expect(() => evalExpr('<add><field name="x"/><int v="1"/></add>', { x: '375' })).toThrow(
      /wrap it in <to_number>/,
    );
  });
});

describe('let / var', () => {
  it('binds and reads a variable', () => {
    expect(evalExpr('<let name="a"><int v="5"/></let><var name="a"/>')).toBe('5');
  });

  it('a later let sees an earlier one', () => {
    expect(
      evalExpr(
        '<let name="a"><int v="5"/></let>' +
          '<let name="b"><add><var name="a"/><int v="1"/></add></let>' +
          '<var name="b"/>',
      ),
    ).toBe('6');
  });

  it('errors on an unbound var', () => {
    expect(() => evalExpr('<var name="z"/>')).toThrow(/not bound/);
  });
});

describe('arithmetic', () => {
  it('add sums all children (empty = 0)', () => {
    expect(evalExpr('<add><int v="2"/><int v="3"/><int v="4"/></add>')).toBe('9');
    expect(evalExpr('<add/>')).toBe('0');
  });

  it('multiply (empty = 1)', () => {
    expect(evalExpr('<multiply><int v="2"/><int v="3"/><int v="4"/></multiply>')).toBe('24');
    expect(evalExpr('<multiply/>')).toBe('1');
  });

  it('subtract is first minus the rest', () => {
    expect(evalExpr('<subtract><int v="10"/><int v="3"/><int v="2"/></subtract>')).toBe('5');
  });

  it('mod is Euclidean and requires 2 children', () => {
    expect(evalExpr('<mod><int v="17"/><int v="5"/></mod>')).toBe('2');
    expect(() => evalExpr('<mod><int v="1"/></mod>')).toThrow(/exactly 2 children/);
    expect(() => evalExpr('<mod><int v="1"/><int v="0"/></mod>')).toThrow(/must not be zero/);
  });

  it('divide floors', () => {
    expect(evalExpr('<divide><int v="17"/><int v="5"/></divide>')).toBe('3');
  });

  it('coerces a single digit string to int', () => {
    expect(evalExpr('<add><field name="d"/><int v="1"/></add>', { d: '8' })).toBe('9');
  });

  it('rejects a multi-digit string in arithmetic (needs <to_number>)', () => {
    expect(() => evalExpr('<add><field name="d"/><int v="1"/></add>', { d: '80' })).toThrow(
      /to_number/,
    );
  });

  it('nests arbitrarily', () => {
    expect(evalExpr('<add><multiply><int v="3"/><int v="4"/></multiply><int v="2"/></add>')).toBe(
      '14',
    );
  });
});
