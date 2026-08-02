import { describe, expect, it } from 'vitest';

import { applyCase, applyFilter, applyMask, isCaseTransform } from '../../src/format/transforms.js';

describe('applyCase', () => {
  it('upper / lower', () => {
    expect(applyCase('upper', 'Москва')).toBe('МОСКВА');
    expect(applyCase('lower', 'Москва')).toBe('москва');
    expect(applyCase('upper', 'John Dow')).toBe('JOHN DOW');
  });

  it('capitalize — first char up, rest unchanged', () => {
    expect(applyCase('capitalize', 'иван')).toBe('Иван');
    expect(applyCase('capitalize', 'иВАН')).toBe('ИВАН');
    expect(applyCase('capitalize', '')).toBe('');
  });

  it('title — each word first up, rest unchanged', () => {
    expect(applyCase('title', 'john dow')).toBe('John Dow');
    expect(applyCase('title', 'the quick brown')).toBe('The Quick Brown');
  });

  it('throws on an unknown transform', () => {
    expect(() => applyCase('sideways', 'x')).toThrow(/unknown case/);
  });

  it('isCaseTransform', () => {
    expect(isCaseTransform('upper')).toBe(true);
    expect(isCaseTransform('nope')).toBe(false);
  });
});

describe('applyMask', () => {
  it('x slots + literal separators (SNILS)', () => {
    expect(applyMask('xxx-xxx-xxx xx', '11223344595')).toBe('112-233-445 95');
  });

  it('groups a card number', () => {
    expect(applyMask('xxxx xxxx xxxx xxxx', '4111111111111111')).toBe('4111 1111 1111 1111');
  });

  it('w takes a word and swallows one delimiter', () => {
    expect(applyMask('w:w', 'John Dow')).toBe('John:Dow');
    expect(applyMask('w, w', 'John Dow')).toBe('John, Dow');
  });

  it('* takes the rest', () => {
    expect(applyMask('x-*', 'ABCDEF')).toBe('A-BCDEF');
    expect(applyMask('w / *', 'John of the North')).toBe('John / of the North');
  });

  it('is lenient: short input leaves later slots empty, extra input is dropped', () => {
    expect(applyMask('xxx-xxx', '12')).toBe('12-');
    expect(applyMask('xx', '123456')).toBe('12');
  });

  it('backslash escapes a literal x/w/*', () => {
    expect(applyMask('\\xxx', '12')).toBe('x12');
    expect(applyMask('N\\wx', '9')).toBe('Nw9');
  });

  it('is code-point aware', () => {
    expect(applyMask('x-x', '😀🎉')).toBe('😀-🎉');
  });
});

describe('applySlice / applyReplace / applyTrim / applyGroup', () => {
  it('slice by code-point index', async () => {
    const { applySlice } = await import('../../src/format/transforms.js');
    expect(applySlice('abcdef', 1, 4)).toBe('bcd');
    expect(applySlice('abcdef', 2)).toBe('cdef');
  });
  it('replace all occurrences', async () => {
    const { applyReplace } = await import('../../src/format/transforms.js');
    expect(applyReplace('a-b-c', '-', '/')).toBe('a/b/c');
  });
  it('trim', async () => {
    const { applyTrim } = await import('../../src/format/transforms.js');
    expect(applyTrim('  hi  ')).toBe('hi');
  });
  it('group from the right', async () => {
    const { applyGroup } = await import('../../src/format/transforms.js');
    expect(applyGroup('1234567', 3, ' ')).toBe('1 234 567');
    expect(applyGroup('1234567', 3, ',')).toBe('1,234,567');
  });
});

describe('applyFilter (interpolation filter dispatch)', () => {
  it('dispatches every filter incl. group default space', async () => {
    const { applyFilter } = await import('../../src/format/transforms.js');
    expect(applyFilter('upper', undefined, 'hi')).toBe('HI');
    expect(applyFilter('slice', '0,2', 'hello')).toBe('he');
    expect(applyFilter('replace', '-,/', 'a-b')).toBe('a/b');
    expect(applyFilter('trim', undefined, ' x ')).toBe('x');
    expect(applyFilter('group', '3', '1234567')).toBe('1 234 567');
    expect(applyFilter('unknown', undefined, 'x')).toBe('x');
  });
});

/**
 * `<data>` assembles text and knows nothing about the file being written, so a
 * value carrying the delimiter silently splits the row. Measured on a real
 * catalogue: one product named "Набор ножей, 3 шт" turned 6172 of 50 000 rows
 * into eight fields where the header declared seven — no error, nothing
 * visibly wrong. These two filters are the one-word fix.
 */
describe('csv filter — RFC 4180 quoting', () => {
  it('quotes unconditionally, so no rule has to be remembered', () => {
    expect(applyFilter('csv', undefined, 'plain')).toBe('"plain"');
  });

  it('survives the delimiter, quotes and newlines inside a value', () => {
    expect(applyFilter('csv', undefined, 'Набор ножей, 3 шт')).toBe('"Набор ножей, 3 шт"');
    expect(applyFilter('csv', undefined, 'Кофе "Арабика"')).toBe('"Кофе ""Арабика"""');
    expect(applyFilter('csv', undefined, 'a\nb')).toBe('"a\nb"');
  });

  it('round-trips through a strict reader', () => {
    // Minimal RFC 4180 reader: what any consumer would do with the field.
    const unquote = (s: string): string => s.slice(1, -1).replace(/""/g, '"');
    for (const v of ['plain', 'a,b', 'say "hi"', 'both, and "quotes"', '']) {
      expect(unquote(applyFilter('csv', undefined, v))).toBe(v);
    }
  });
});

describe('sql filter — single-quoted literal body', () => {
  it('doubles the apostrophe that would close the string', () => {
    expect(applyFilter('sql', undefined, "O'Brien")).toBe("O''Brien");
    expect(applyFilter('sql', undefined, "D'Angelo's")).toBe("D''Angelo''s");
  });

  it('emits the BODY only, so the config keeps its own quotes', () => {
    expect(applyFilter('sql', undefined, 'Смирнов')).toBe('Смирнов');
    expect(applyFilter('sql', undefined, "O'Brien").startsWith("'")).toBe(false);
  });

  it('leaves double quotes alone — they are not the SQL string delimiter', () => {
    expect(applyFilter('sql', undefined, 'Кофе "Арабика"')).toBe('Кофе "Арабика"');
  });
});
