import { describe, expect, it } from 'vitest';

import { evalExpr } from './helpers.js';

describe('list literal', () => {
  it('parses a comma-separated int list and reads by index', () => {
    expect(evalExpr('<at><in><list v="2,4,10"/></in><index><int v="2"/></index></at>')).toBe('10');
  });

  it('empty list literal', () => {
    expect(evalExpr('<length><list v=""/></length>')).toBe('0');
  });
});

describe('length', () => {
  it('counts string characters', () => {
    expect(evalExpr('<length><field name="s"/></length>', { s: 'hello' })).toBe('5');
  });

  it('counts by code point (astral char = 1)', () => {
    expect(evalExpr('<length><field name="s"/></length>', { s: '😀😀' })).toBe('2');
  });
});

describe('each (map/transform)', () => {
  it('transforms each character and joins', () => {
    // double every digit's numeric value, join the results
    expect(
      evalExpr(
        '<join sep=","><each><over><field name="s"/></over>' +
          '<do><multiply><current/><int v="2"/></multiply></do></each></join>',
        { s: '123' },
      ),
    ).toBe('2,4,6');
  });

  it('exposes current-index', () => {
    expect(
      evalExpr(
        '<join sep=","><each><over><field name="s"/></over>' +
          '<do><current_index/></do></each></join>',
        { s: 'abc' },
      ),
    ).toBe('0,1,2');
  });
});

describe('reduce', () => {
  it('sums digit values with acc', () => {
    expect(
      evalExpr(
        '<reduce><over><field name="s"/></over><init><int v="0"/></init>' +
          '<do><add><acc/><current/></add></do></reduce>',
        { s: '12345' },
      ),
    ).toBe('15');
  });

  it('empty collection yields init', () => {
    expect(
      evalExpr(
        '<reduce><over><field name="s"/></over><init><int v="99"/></init>' +
          '<do><add><acc/><current/></add></do></reduce>',
        { s: '' },
      ),
    ).toBe('99');
  });

  it('iterates a list literal, not just a string', () => {
    expect(
      evalExpr(
        '<reduce><over><list v="10,20,30"/></over><init><int v="0"/></init>' +
          '<do><add><acc/><current/></add></do></reduce>',
      ),
    ).toBe('60');
  });

  it('a <let> inside <do> preserves acc/current (iteration context not dropped)', () => {
    // sum of 2*each over "123" = 2+4+6 = 12; the <let> must not strip <acc/>
    expect(
      evalExpr(
        '<reduce><over><field name="s"/></over><init><int v="0"/></init>' +
          '<do><let name="doubled"><multiply><current/><int v="2"/></multiply></let>' +
          '<add><acc/><use name="doubled"/></add></do></reduce>',
        { s: '123' },
      ),
    ).toBe('12');
  });
});

describe('join', () => {
  it('joins with no separator by default', () => {
    expect(
      evalExpr('<join><each><over><field name="s"/></over><do><current/></do></each></join>', {
        s: 'xyz',
      }),
    ).toBe('xyz');
  });
});

describe('at', () => {
  it('returns the default when out of range', () => {
    expect(
      evalExpr('<at default="0"><in><list v="7,8"/></in><index><int v="5"/></index></at>'),
    ).toBe('0');
  });

  it('errors out of range without a default', () => {
    expect(() => evalExpr('<at><in><list v="7,8"/></in><index><int v="5"/></index></at>')).toThrow(
      /out of range/,
    );
  });
});

describe('contextual tags outside iteration', () => {
  it('<current/> errors outside a <do>', () => {
    expect(() => evalExpr('<current/>')).toThrow(/outside an iteration/);
  });

  it('<acc/> errors outside a <reduce>', () => {
    expect(() => evalExpr('<acc/>')).toThrow(/outside a <reduce>/);
  });
});

describe('split — the fourth way to get a list', () => {
  it('cuts a string the way join glued it, and is its exact inverse', () => {
    expect(
      evalExpr('<join sep="-"><split sep="|"><field name="s"/></split></join>', { s: 'a|b|c' }),
    ).toBe('a-b-c');
  });

  it('reads back a column repeat= joined, which is what it exists for', () => {
    // Σ qty × price over the lines of one order — the sum that could not be written while a
    // repeating column was only ever a single glued string.
    expect(
      evalExpr(
        '<reduce><over><split sep="|"><field name="q"/></split></over>' +
          '<init><int v="0"/></init>' +
          '<do><add><acc/><multiply>' +
          '<to_number><current/></to_number>' +
          '<to_number><at><in><split sep="|"><field name="p"/></split></in>' +
          '<index><current_index/></index></at></to_number>' +
          '</multiply></add></do></reduce>',
        { q: '2|3|1', p: '24|81|61' },
      ),
    ).toBe('352');
  });

  it('a multi-character separator is one separator, not a set of them', () => {
    expect(
      evalExpr('<length><split sep=", "><field name="s"/></split></length>', { s: 'a, b, c' }),
    ).toBe('3');
  });

  it('keeps an empty piece rather than dropping it, so positions line up', () => {
    // `a||c` is three lines, the middle one blank. Dropping it would slide `c` into index 1 and
    // pair it with the wrong price.
    expect(
      evalExpr('<length><split sep="|"><field name="s"/></split></length>', { s: 'a||c' }),
    ).toBe('3');
  });

  it('a separator that does not occur gives the whole string as one piece', () => {
    expect(
      evalExpr('<length><split sep="|"><field name="s"/></split></length>', { s: 'solo' }),
    ).toBe('1');
  });

  it('refuses an empty separator instead of picking one language’s answer', () => {
    expect(() => evalExpr('<split sep=""><field name="s"/></split>', { s: 'abc' })).toThrow(
      /sep= is empty/,
    );
  });

  it('refuses a list, which has nothing to cut', () => {
    expect(() => evalExpr('<split sep="|"><list v="1,2"/></split>')).toThrow(/expected a string/);
  });
});
