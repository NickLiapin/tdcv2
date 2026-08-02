import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REGEX_MAX_LENGTH,
  RegexGeneratorError,
  parseRegexMaxLength,
  parseRegexProgram,
  regexGenerator,
} from '../../src/generators/regex.js';
import { createPrng } from '../../src/prng/prng.js';

function generate(pattern: string, count = 100, seed = `seed:${pattern}`): readonly string[] {
  return regexGenerator({ pattern, regexMaxLength: 256 })(count, createPrng(seed));
}

function expectGenerated(
  pattern: string,
  matcher: RegExp | ((value: string) => void),
  count = 100,
): readonly string[] {
  const out = generate(pattern, count);
  expect(out).toHaveLength(count);
  for (const value of out) {
    if (matcher instanceof RegExp) {
      expect(value).toMatch(matcher);
    } else {
      matcher(value);
    }
  }
  return out;
}

describe('regexGenerator — generation', () => {
  it('generates strings matching bounded character classes', () => {
    const out = expectGenerated('[A-Z]{2}[0-9]{6}', /^[A-Z]{2}[0-9]{6}$/);
    expect(new Set(out).size).toBeGreaterThan(1);
  });

  it('generates literal-only patterns without consuming semantic choices', () => {
    const out = generate('literal_VALUE-42', 5);
    expect(out).toEqual(new Array<string>(5).fill('literal_VALUE-42'));
  });

  it('supports escaped literals for regex metacharacters', () => {
    const out = generate('\\.\\+\\(\\)\\[\\]\\{\\}\\\\', 3);
    expect(out).toEqual(new Array<string>(3).fill('.+()[]{}\\'));
  });

  it('supports alternation, escaped literals, and bounded repeats', () => {
    expectGenerated('user_[a-z0-9]{8}@test\\.(com|org)', /^user_[a-z0-9]{8}@test\.(com|org)$/);
  });

  it('supports empty alternatives', () => {
    const out = expectGenerated('ID-(A|B|){2}', /^ID-(A|B){0,2}$/);
    expect(out.some((value) => value.length < 5)).toBe(true);
  });

  it('supports nested alternation and exact repetition', () => {
    expectGenerated('(?:cat|dog|fox){2}', /^(cat|dog|fox){2}$/);
  });

  it('supports optional quantifiers', () => {
    const out = expectGenerated('AB?C', /^AB?C$/);
    expect(out).toContain('AC');
    expect(out).toContain('ABC');
  });

  it('supports zero-count quantifiers', () => {
    const out = generate('A{0}B', 10);
    expect(out).toEqual(new Array<string>(10).fill('B'));
    expect(parseRegexProgram('A{0}B').maxLength).toBe(1);
  });

  it('supports variable bounded quantifiers', () => {
    const out = expectGenerated('X[0-9]{2,5}Y', /^X[0-9]{2,5}Y$/);
    const lengths = new Set(out.map((value) => value.length));
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(7);
    expect(lengths.size).toBeGreaterThan(1);
  });

  it('supports dot wildcard over printable ASCII only', () => {
    expectGenerated('.{12}', (value) => {
      expect(value).toHaveLength(12);
      for (const ch of value) {
        const code = ch.codePointAt(0);
        expect(code).toBeGreaterThanOrEqual(32);
        expect(code).toBeLessThanOrEqual(126);
      }
    });
  });

  it('treats anchors as zero-width markers', () => {
    const out = generate('^ABC$', 10);
    expect(out).toEqual(new Array<string>(10).fill('ABC'));
    expect(parseRegexProgram('^ABC$').maxLength).toBe(3);
  });

  it('supports capturing groups and backreferences', () => {
    expectGenerated('([0-9]{3})-[A-Z]{2}-\\1', /^([0-9]{3})-[A-Z]{2}-\1$/);
  });

  it('supports nested capturing groups and multiple backreferences', () => {
    expectGenerated('((A|B)[0-9])-\\1-\\2', /^((A|B)[0-9])-\1-\2$/);
  });

  it('uses the last capture value from repeated capturing groups', () => {
    expectGenerated('([A-Z]){3}\\1', /^([A-Z]){3}\1$/);
  });

  it('supports non-capturing groups without changing backreference numbering', () => {
    expectGenerated('(?:AB|CD)([0-9]{2})-\\1', /^(AB|CD)([0-9]{2})-\2$/);
  });

  it('supports shorthand character classes outside brackets', () => {
    expectGenerated('\\d{4}-\\w{3}-\\s\\D\\W\\S', (value) => {
      expect(value).toHaveLength(13);
      expect(value.slice(0, 4)).toMatch(/^\d{4}$/);
      expect(value[4]).toBe('-');
      expect(value.slice(5, 8)).toMatch(/^\w{3}$/);
      expect(value[8]).toBe('-');
      expect([' ', '\t']).toContain(value[9]);
      expect(value[10]).not.toMatch(/^\d$/);
      expect(value[11]).not.toMatch(/^\w$/);
      expect([' ', '\t']).not.toContain(value[12]);
    });
  });

  it('supports shorthand character classes inside brackets', () => {
    expectGenerated('[\\dA-F]{8}', /^[0-9A-F]{8}$/);
    expectGenerated('[\\w-]{8}', /^[A-Za-z0-9_-]{8}$/);
    expectGenerated('[\\sX]{8}', /^[\t X]{8}$/);
  });

  it('supports Unicode BMP ranges in character classes', () => {
    expectGenerated('[а-я]{8}', /^[а-я]{8}$/u);
    expectGenerated('[א-ת]{6}', /^[א-ת]{6}$/u);
    expectGenerated('[ぁ-ゖ]{6}', /^[ぁ-ゖ]{6}$/u);
  });

  it('supports named Unicode alphabets via \\a{name}', () => {
    expectGenerated('\\a{cyrillic.ru.letters}{8}', /^[А-ЯЁа-яё]{8}$/u);
    expectGenerated('\\a{kana.hiragana}{6}', /^[ぁ-ゖ]{6}$/u);
    expectGenerated('[\\a{arabic.letters}\\a{hebrew.letters}]{6}', (value) => {
      expect(value).toMatch(/^[\u0621-\u064A\u05D0-\u05EA]{6}$/u);
    });
  });

  it('supports literal hyphens inside character classes', () => {
    expectGenerated('[-A-C]{8}', /^[-A-C]{8}$/);
    expectGenerated('[A-C-]{8}', /^[-A-C]{8}$/);
  });

  it('supports negated classes over printable ASCII', () => {
    expectGenerated('[^0-9]{12}', (value) => {
      expect(value).toHaveLength(12);
      expect(value).not.toMatch(/[0-9]/);
    });
  });

  it('supports empty regex patterns as empty strings', () => {
    const out = generate('', 5);
    expect(out).toEqual(new Array<string>(5).fill(''));
    expect(parseRegexProgram('').maxLength).toBe(0);
  });

  it('returns an empty array for count=0', () => {
    const out = regexGenerator({ pattern: '[A-Z]{2}' })(0, createPrng('zero-count'));
    expect(out).toEqual([]);
  });

  it('is deterministic for the same seed', () => {
    const gen = regexGenerator({ pattern: '[A-F]{4}[0-9]{4}' });
    const a = gen(50, createPrng('same-regex'));
    const b = gen(50, createPrng('same-regex'));
    const c = gen(50, createPrng('other-regex'));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('regexGenerator — length analysis', () => {
  it('reports maximum generated length for sequences, branches, repeats, and backrefs', () => {
    expect(parseRegexProgram('([0-9]{3})-[A-Z]{2}-\\1').maxLength).toBe(10);
    expect(parseRegexProgram('(?:cat|tiger){2}', { regexMaxLength: 10 }).maxLength).toBe(10);
    expect(parseRegexProgram('A(B|CDE)?F').maxLength).toBe(5);
    expect(parseRegexProgram('([A-Z]{2,4})\\1', { regexMaxLength: 8 }).maxLength).toBe(8);
    expect(parseRegexProgram('\\a{hebrew.letters}{4}').maxLength).toBe(4);
  });

  it('uses regex_max_length as a safety limit', () => {
    expect(() => parseRegexProgram('[a-z]{33}')).toThrow(/regex_max_length=32/);
    expect(parseRegexProgram('[a-z]{33}', { regexMaxLength: 33 }).maxLength).toBe(33);
  });

  it('parses regex_max_length values strictly', () => {
    expect(parseRegexMaxLength(undefined)).toBe(DEFAULT_REGEX_MAX_LENGTH);
    expect(parseRegexMaxLength(undefined, 64)).toBe(64);
    expect(parseRegexMaxLength('64')).toBe(64);
    expect(parseRegexMaxLength(' 64 ')).toBe(64);
    expect(parseRegexMaxLength(64)).toBe(64);
    expect(() => parseRegexMaxLength('0')).toThrow(/positive integer/);
    expect(() => parseRegexMaxLength('-1')).toThrow(/positive integer/);
    expect(() => parseRegexMaxLength('1.5')).toThrow(/positive integer/);
    expect(() => parseRegexMaxLength('nope')).toThrow(/positive integer/);
  });

  it('throws typed errors for invalid regex programs', () => {
    expect(() => parseRegexProgram('[a-z]+')).toThrow(RegexGeneratorError);
  });
});

describe('regexGenerator — rejected constructs', () => {
  it('rejects unbounded quantifiers', () => {
    expect(() => regexGenerator({ pattern: '[a-z]+' })).toThrow(/unbounded/);
    expect(() => regexGenerator({ pattern: '[a-z]*' })).toThrow(/unbounded/);
    expect(() => regexGenerator({ pattern: '[a-z]{1,}' })).toThrow(/unbounded/);
  });

  it('rejects unsupported group constructs', () => {
    expect(() => regexGenerator({ pattern: '(?=a)a' })).toThrow(/not supported/);
    expect(() => regexGenerator({ pattern: '(?!a)a' })).toThrow(/not supported/);
    expect(() => regexGenerator({ pattern: '(?<=a)b' })).toThrow(/not supported/);
    expect(() => regexGenerator({ pattern: '(?<name>a)' })).toThrow(/not supported/);
  });

  it('rejects invalid backreferences', () => {
    expect(() => regexGenerator({ pattern: '\\1([0-9])' })).toThrow(/not generated yet/);
    expect(() => regexGenerator({ pattern: '(A\\1)' })).toThrow(/not generated yet/);
    expect(() => regexGenerator({ pattern: '(A)\\2' })).toThrow(/not generated yet/);
  });

  it('rejects malformed groups and classes', () => {
    expect(() => regexGenerator({ pattern: '(abc' })).toThrow(/expected "\)"/);
    expect(() => regexGenerator({ pattern: 'abc)' })).toThrow(/unexpected "\)"/);
    expect(() => regexGenerator({ pattern: '[abc' })).toThrow(/expected "\]"/);
    expect(() => regexGenerator({ pattern: '[]' })).toThrow(/empty character classes/);
    expect(() => regexGenerator({ pattern: '[^ -~]' })).toThrow(/no available characters/);
  });

  it('rejects invalid character class ranges', () => {
    expect(() => regexGenerator({ pattern: '[z-a]' })).toThrow(/invalid character range/);
    expect(() => regexGenerator({ pattern: '[\\d-a]' })).toThrow(/single-character endpoints/);
  });

  it('rejects malformed quantifiers', () => {
    expect(() => regexGenerator({ pattern: '*a' })).toThrow(/has no target/);
    expect(() => regexGenerator({ pattern: '?a' })).toThrow(/has no target/);
    expect(() => regexGenerator({ pattern: '{2}a' })).toThrow(/has no target/);
    expect(() => regexGenerator({ pattern: 'A{,2}' })).toThrow(/must start with a number/);
    expect(() => regexGenerator({ pattern: 'A{2,1}' })).toThrow(/invalid quantifier bounds/);
    expect(() => regexGenerator({ pattern: 'A{2' })).toThrow(/expected ","/);
    expect(() => regexGenerator({ pattern: 'A??' })).toThrow(/lazy quantifiers/);
    expect(() => regexGenerator({ pattern: 'A{1,2}?' })).toThrow(/lazy quantifiers/);
    expect(() => regexGenerator({ pattern: 'A{1}{2}' })).toThrow(/stacked quantifiers/);
  });

  it('rejects unsupported escapes and dangling escapes', () => {
    expect(() => regexGenerator({ pattern: 'a\\' })).toThrow(/dangling escape/);
    expect(() => regexGenerator({ pattern: '\\n' })).toThrow(/multiline escapes/);
    expect(() => regexGenerator({ pattern: '[\\r]' })).toThrow(/multiline escapes/);
    expect(() => regexGenerator({ pattern: '\\p{L}' })).toThrow(/Unicode property/);
    expect(() => regexGenerator({ pattern: '[\\P]' })).toThrow(/Unicode property/);
  });

  it('rejects malformed named alphabet escapes', () => {
    expect(() => regexGenerator({ pattern: '\\a{}' })).toThrow(/non-empty name/);
    expect(() => regexGenerator({ pattern: '\\a{unknown}' })).toThrow(/unknown alphabet/);
    expect(() => regexGenerator({ pattern: '[\\a{unknown}]' })).toThrow(/unknown alphabet/);
    expect(() => regexGenerator({ pattern: '[\\a{kana.hiragana}-z]' })).toThrow(
      /single-character endpoints/,
    );
  });

  it('rejects unsafe maximum-length arithmetic', () => {
    expect(() =>
      parseRegexProgram('(?:a{9007199254740991}){2}', {
        regexMaxLength: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/maximum length is too large/);
  });
});
