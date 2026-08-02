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
          '<add><acc/><var name="doubled"/></add></do></reduce>',
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
