import { describe, expect, it } from 'vitest';

import {
  SymbolGeneratorError,
  parseSymbolLength,
  symbolGenerator,
} from '../../src/generators/symbol.js';
import { randomChars } from '../../src/presets/utils.js';
import { createPrng } from '../../src/prng/prng.js';
import { ALPHABET_NAMES, resolveAlphabetChars } from '../../src/unicode/alphabets.js';

function generate(alphabet: string, length: number, count = 50): readonly string[] {
  return symbolGenerator({ alphabet, length })(
    count,
    createPrng(`symbol:${alphabet}:${String(length)}`),
  );
}

function expectAlphabetValues(values: readonly string[], alphabet: string, length: number): void {
  const chars = resolveAlphabetChars(alphabet);
  expect(chars).toBeDefined();
  const allowed = new Set(chars);
  for (const value of values) {
    expect(Array.from(value)).toHaveLength(length);
    for (const char of value) expect(allowed.has(char)).toBe(true);
  }
}

describe('symbolGenerator', () => {
  it('lists the Unicode alphabets used by DSL-facing generators', () => {
    expect(ALPHABET_NAMES).toContain('cyrillic.ru.letters');
    expect(ALPHABET_NAMES).toContain('kana.hiragana');
    expect(ALPHABET_NAMES).toContain('kana.katakana');
    expect(ALPHABET_NAMES).toContain('arabic.letters');
    expect(ALPHABET_NAMES).toContain('hebrew.letters');
    expect(ALPHABET_NAMES).toContain('cjk.unified.basic');
    expect(ALPHABET_NAMES).toContain('roman.upper');
  });

  it('generates fixed-length strings from named Unicode alphabets', () => {
    expectAlphabetValues(generate('cyrillic.ru.letters', 12), 'cyrillic.ru.letters', 12);
    expectAlphabetValues(generate('kana.hiragana', 8), 'kana.hiragana', 8);
    expectAlphabetValues(generate('arabic.letters', 6), 'arabic.letters', 6);
    expectAlphabetValues(generate('hebrew.letters', 6), 'hebrew.letters', 6);
    expectAlphabetValues(generate('cjk.unified.basic', 4), 'cjk.unified.basic', 4);
  });

  it('supports fullwidth digits and roman numeral alphabets', () => {
    const fullwidth = generate('digits.fullwidth', 10);
    expectAlphabetValues(fullwidth, 'digits.fullwidth', 10);
    expect(fullwidth.every((value) => /^[０-９]{10}$/u.test(value))).toBe(true);

    const roman = generate('roman.upper', 7);
    expectAlphabetValues(roman, 'roman.upper', 7);
    expect(roman.every((value) => /^[IVXLCDM]{7}$/.test(value))).toBe(true);
  });

  it('is deterministic for the same seed', () => {
    const gen = symbolGenerator({ alphabet: 'kana.katakana', length: 10 });
    const a = gen(25, createPrng('same-symbol'));
    const b = gen(25, createPrng('same-symbol'));
    const c = gen(25, createPrng('other-symbol'));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('parses length strictly', () => {
    expect(parseSymbolLength(undefined)).toBe(1);
    expect(parseSymbolLength('8')).toBe(8);
    expect(parseSymbolLength(' 12 ')).toBe(12);
    expect(() => parseSymbolLength('0')).toThrow(/from 1 to/);
    expect(() => parseSymbolLength('1.5')).toThrow(/from 1 to/);
    expect(() => parseSymbolLength('bad')).toThrow(/from 1 to/);
    expect(() => parseSymbolLength('1025')).toThrow(/from 1 to/);
  });

  it('throws typed errors for missing and unknown alphabets', () => {
    expect(() => symbolGenerator({ length: 4 })).toThrow(SymbolGeneratorError);
    expect(() => symbolGenerator({ alphabet: 'kana.hiraganaa', length: 4 })).toThrow(
      /unknown alphabet/,
    );
  });

  it('keeps shared randomChars code-point safe for non-BMP alphabets', () => {
    const out = randomChars(createPrng('emoji-random-chars'), '😀😁😂', 12);
    expect(Array.from(out)).toHaveLength(12);
    for (const char of Array.from(out)) {
      expect(['😀', '😁', '😂']).toContain(char);
    }
  });

  it('draws from an inline value set (literals, any script)', () => {
    const out = symbolGenerator({ value: 'कखगघचछ', length: 1 })(30, createPrng('v1'));
    const allowed = new Set(['क', 'ख', 'ग', 'घ', 'च', 'छ']);
    for (const v of out) expect(allowed.has(v)).toBe(true);
  });

  it('draws from an inline range set', () => {
    const out = symbolGenerator({ value: '[a-f]', length: 4 })(20, createPrng('v2'));
    for (const v of out) {
      expect(Array.from(v)).toHaveLength(4);
      for (const c of v) expect('abcdef'.includes(c)).toBe(true);
    }
  });

  it('mixes scripts and ranges in one value', () => {
    const out = symbolGenerator({ value: 'あア[0-9]к', length: 1 })(40, createPrng('v3'));
    const allowed = new Set(['あ', 'ア', 'к', ...Array.from('0123456789')]);
    for (const v of out) expect(allowed.has(v)).toBe(true);
  });

  it('rejects using both value and alphabet', () => {
    expect(() => symbolGenerator({ value: 'ab', alphabet: 'latin.lower', length: 1 })).toThrow(
      /not both/,
    );
  });

  it('rejects an empty inline set and neither-attribute', () => {
    expect(() => symbolGenerator({ value: ' , ', length: 1 })).toThrow(/empty character set/);
    expect(() => symbolGenerator({ length: 2 })).toThrow(SymbolGeneratorError);
  });

  it('exclude removes characters from the set', () => {
    const out = symbolGenerator({ value: '[a-e]', exclude: 'b,d', length: 1 })(
      40,
      createPrng('ex'),
    );
    for (const v of out) expect(['a', 'c', 'e']).toContain(v);
  });

  it('include adds characters to the set', () => {
    const out = symbolGenerator({ value: 'ab', include: '[0-1]', length: 1 })(40, createPrng('in'));
    const allowed = new Set(['a', 'b', '0', '1']);
    for (const v of out) expect(allowed.has(v)).toBe(true);
  });

  it('include and exclude extend/trim a named alphabet', () => {
    const out = symbolGenerator({
      alphabet: 'latin.lower',
      include: '[0-9]',
      exclude: '[a-y]',
      length: 1,
    })(60, createPrng('mod'));
    const allowed = new Set(['z', ...Array.from('0123456789')]);
    for (const v of out) expect(allowed.has(v)).toBe(true);
  });

  it('exclude has the final say over include', () => {
    // include adds "c", exclude removes it → not present.
    const out = symbolGenerator({ value: 'ab', include: 'c', exclude: 'c', length: 1 })(
      30,
      createPrng('prec'),
    );
    for (const v of out) expect(['a', 'b']).toContain(v);
  });

  it('throws when include/exclude empty the set', () => {
    expect(() => symbolGenerator({ value: 'ab', exclude: 'ab', length: 1 })).toThrow(
      /empty after applying include\/exclude/,
    );
  });
});
