import { describe, expect, it } from 'vitest';

import {
  AdvancedRegexGeneratorError,
  advancedRegexGenerator,
  parseAdvancedRegexProgram,
} from '../../src/generators/advanced-regex.js';
import { createPrng } from '../../src/prng/prng.js';

function generate(pattern: string, count = 100, seed = `advanced:${pattern}`): readonly string[] {
  return advancedRegexGenerator({ pattern, regexMaxLength: 512 })(count, createPrng(seed));
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

function countWhere(values: readonly string[], predicate: (value: string) => boolean): number {
  return values.filter(predicate).length;
}

function valueCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

describe('advancedRegexGenerator — finite regex core', () => {
  it('generates bounded character classes with variety', () => {
    const out = expectGenerated('[A-Z]{2}[0-9]{6}', /^[A-Z]{2}[0-9]{6}$/);
    expect(new Set(out).size).toBeGreaterThan(1);
  });

  it('generates literal-only patterns', () => {
    const out = generate('literal_VALUE-42', 5);
    expect(out).toEqual(new Array<string>(5).fill('literal_VALUE-42'));
  });

  it('supports escaped regex metacharacters as literals', () => {
    const out = generate('\\.\\+\\(\\)\\[\\]\\{\\}\\\\', 3);
    expect(out).toEqual(new Array<string>(3).fill('.+()[]{}\\'));
  });

  it('supports empty patterns', () => {
    const out = generate('', 5);
    expect(out).toEqual(new Array<string>(5).fill(''));
    expect(parseAdvancedRegexProgram('').maxLength).toBe(0);
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
    expect(parseAdvancedRegexProgram('A{0}B').maxLength).toBe(1);
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
    expect(parseAdvancedRegexProgram('^ABC$').maxLength).toBe(3);
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

  it('supports Unicode BMP ranges and named alphabets', () => {
    expectGenerated('[а-я]{8}', /^[а-я]{8}$/u);
    expectGenerated('\\a{kana.katakana}{6}', /^[ァ-ヺ]{6}$/u);
    expectGenerated('[\\a{arabic.letters}\\a{hebrew.letters}]{6}', (value) => {
      expect(value).toMatch(/^[\u0621-\u064A\u05D0-\u05EA]{6}$/u);
    });
    expect(parseAdvancedRegexProgram('\\a{cjk.unified.basic}{4}').maxLength).toBe(4);
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

  it('returns an empty array for count=0', () => {
    const out = advancedRegexGenerator({ pattern: '[A-Z]{2}' })(0, createPrng('zero-count'));
    expect(out).toEqual([]);
  });
});

describe('advancedRegexGenerator — logical links via captures and backrefs', () => {
  it('supports capturing groups and backreferences', () => {
    expectGenerated('([0-9]{3})-[A-Z]{2}-\\1', /^([0-9]{3})-[A-Z]{2}-\1$/);
  });

  it('supports nested capturing groups and multiple backreferences', () => {
    expectGenerated('((A|B)[0-9])-\\1-\\2', /^((A|B)[0-9])-\1-\2$/);
  });

  it('uses the last capture value from repeated capturing groups', () => {
    expectGenerated('([A-Z]){3}\\1', /^([A-Z]){3}\1$/);
  });

  it('keeps non-capturing groups out of backreference numbering', () => {
    expectGenerated('(?:AB|CD)([0-9]{2})-\\1', /^(AB|CD)([0-9]{2})-\2$/);
  });

  it('lets weighted branches reuse a capture generated before the choice', () => {
    const out = generate('([A-W]{2})-(?%{50:\\1;50:XX})', 40, 'capture-before-weighted');
    expect(countWhere(out, (value) => /^([A-W]{2})-\1$/.test(value))).toBe(20);
    expect(countWhere(out, (value) => /^[A-W]{2}-XX$/.test(value))).toBe(20);
  });

  it('keeps branch-local captures available to later backrefs only on rows that took the branch', () => {
    const out = generate('(?%{40:(A[0-9]);60:B})-\\1', 50, 'branch-local-capture');
    expect(countWhere(out, (value) => /^(A[0-9])-\1$/.test(value))).toBe(20);
    expect(countWhere(out, (value) => value === 'B-')).toBe(30);
  });
});

describe('advancedRegexGenerator — weighted choices', () => {
  it('materializes weighted choices exactly for a known count', () => {
    const out = generate('(?%{70:RU;20:US;10:DE})-[0-9]{2}', 100, 'weighted-country');
    expect(countWhere(out, (value) => value.startsWith('RU-'))).toBe(70);
    expect(countWhere(out, (value) => value.startsWith('US-'))).toBe(20);
    expect(countWhere(out, (value) => value.startsWith('DE-'))).toBe(10);
    for (const value of out) {
      expect(value).toMatch(/^(RU|US|DE)-[0-9]{2}$/);
    }
  });

  it('uses Hamilton rounding for counts that do not divide percentages evenly', () => {
    const out = generate('(?%{33:A;33:B;34:C})', 10, 'weighted-hamilton');
    const counts = valueCounts(out);
    expect(counts.get('A')).toBe(3);
    expect(counts.get('B')).toBe(3);
    expect(counts.get('C')).toBe(4);
  });

  it('supports decimal percentages', () => {
    const out = generate('(?%{12.5:A;37.5:B;50:C})', 8, 'weighted-decimals');
    const counts = valueCounts(out);
    expect(counts.get('A')).toBe(1);
    expect(counts.get('B')).toBe(3);
    expect(counts.get('C')).toBe(4);
  });

  it('supports empty weighted branches', () => {
    const out = generate('ID(?%{25:;75:-X})', 20, 'weighted-empty-branch');
    const counts = valueCounts(out);
    expect(counts.get('ID')).toBe(5);
    expect(counts.get('ID-X')).toBe(15);
  });

  it('supports escaped weighted-choice separators as branch literals', () => {
    const out = generate('(?%{50:A\\;\\}\\:;50:B})', 10, 'weighted-escaped-separators');
    const counts = valueCounts(out);
    expect(counts.get('A;}:')).toBe(5);
    expect(counts.get('B')).toBe(5);
  });

  it('supports nested weighted choices inside branch patterns', () => {
    const out = generate('(?%{50:A(?%{80:X;20:Y});50:B})', 100, 'nested-weighted');
    const counts = valueCounts(out);
    expect(counts.get('AX')).toBe(40);
    expect(counts.get('AY')).toBe(10);
    expect(counts.get('B')).toBe(50);
  });

  it('supports multiple independent weighted choices in one pattern', () => {
    const out = generate('(?%{60:M;40:F})-(?%{25:00;75:99})', 100, 'two-weighted');
    expect(countWhere(out, (value) => value.startsWith('M-'))).toBe(60);
    expect(countWhere(out, (value) => value.startsWith('F-'))).toBe(40);
    expect(countWhere(out, (value) => value.endsWith('-00'))).toBe(25);
    expect(countWhere(out, (value) => value.endsWith('-99'))).toBe(75);
  });

  it('supports repeated weighted choices with exact distribution per repetition step', () => {
    const out = generate('(?%{50:A;50:B}){2}', 100, 'repeated-weighted');
    const joined = out.join('');
    expect(joined.match(/A/g)).toHaveLength(100);
    expect(joined.match(/B/g)).toHaveLength(100);
    for (const value of out) {
      expect(value).toMatch(/^[AB]{2}$/);
    }
  });

  it('supports weighted choices inside captures and backreferences', () => {
    const out = generate('((?%{25:AB;75:CD}))-\\1', 40, 'weighted-backref');
    const counts = valueCounts(out);
    expect(counts.get('AB-AB')).toBe(10);
    expect(counts.get('CD-CD')).toBe(30);
  });

  it('allows ordinary alternation inside weighted branches', () => {
    const out = generate('(?%{50:(cat|dog);50:fox})', 100, 'weighted-normal-alt');
    expect(countWhere(out, (value) => value === 'fox')).toBe(50);
    expect(countWhere(out, (value) => value === 'cat' || value === 'dog')).toBe(50);
  });

  it('reports maximum generated length and weighted-choice count', () => {
    const program = parseAdvancedRegexProgram('ID-(?%{30:A[0-9]{2};70:LONG[0-9]{4}})', {
      regexMaxLength: 20,
    });
    expect(program.maxLength).toBe(11);
    expect(program.captureCount).toBe(0);
    expect(program.weightedChoiceCount).toBe(1);
  });

  it('counts nested weighted choices in the parsed program metadata', () => {
    const program = parseAdvancedRegexProgram('(?%{50:A(?%{80:X;20:Y});50:B})');
    expect(program.maxLength).toBe(2);
    expect(program.weightedChoiceCount).toBe(2);
  });

  it('is deterministic for the same seed', () => {
    const pattern = '(?%{60:AA;40:BB})-[A-Z]{3}';
    const a = generate(pattern, 100, 'same-advanced');
    const b = generate(pattern, 100, 'same-advanced');
    const c = generate(pattern, 100, 'other-advanced');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('advancedRegexGenerator — rejected constructs', () => {
  it('rejects weighted choices whose percents do not sum to 100', () => {
    expect(() => parseAdvancedRegexProgram('(?%{70:A;20:B})')).toThrow(/percentages sum to 90/);
    expect(() => parseAdvancedRegexProgram('(?%{70:A;40:B})')).toThrow(/percentages sum to 110/);
  });

  it('rejects malformed weighted-choice headers', () => {
    expect(() => parseAdvancedRegexProgram('(?%{})')).toThrow(/must contain at least one branch/);
    expect(() => parseAdvancedRegexProgram('(?%{x:A;100:B})')).toThrow(/invalid/);
    expect(() => parseAdvancedRegexProgram('(?%{-1:A;101:B})')).toThrow(/invalid/);
    expect(() => parseAdvancedRegexProgram('(?%{1.2.3:A;98.8:B})')).toThrow(/invalid/);
    expect(() => parseAdvancedRegexProgram('(?%{50A;50:B})')).toThrow(/expected ":"/);
  });

  it('rejects malformed weighted-choice structure', () => {
    expect(() => parseAdvancedRegexProgram('(?%{50:A,50:B})')).toThrow(/percentages sum to 50/);
    expect(() => parseAdvancedRegexProgram('(?%{50:A;50:B)')).toThrow(/expected ";" or "}"/);
    expect(() => parseAdvancedRegexProgram('(?%{50:A;50:B}')).toThrow(/expected "\)"/);
    expect(() => parseAdvancedRegexProgram('(?%{50:A;50:B')).toThrow(/expected ";" or "}"/);
  });

  it('rejects unbounded quantifiers', () => {
    expect(() => parseAdvancedRegexProgram('[a-z]+')).toThrow(/unbounded/);
    expect(() => parseAdvancedRegexProgram('[a-z]*')).toThrow(/unbounded/);
    expect(() => parseAdvancedRegexProgram('[a-z]{1,}')).toThrow(/unbounded/);
  });

  /*
   * Lookaround decides what a pattern MATCHES, and this generator matches
   * nothing — it produces. `(?<=a)b` is the one worth pinning: it starts `(?<`
   * exactly as a named group does, and reading it as a group called "=a" would
   * turn a construct that cannot work into one that silently does something else.
   */
  it('rejects unsupported group constructs', () => {
    expect(() => parseAdvancedRegexProgram('(?=a)a')).toThrow(/not supported/);
    expect(() => parseAdvancedRegexProgram('(?!a)a')).toThrow(/not supported/);
    expect(() => parseAdvancedRegexProgram('(?<=a)b')).toThrow(/not supported/);
    expect(() => parseAdvancedRegexProgram('(?<!a)b')).toThrow(/not supported/);
    // A NUMBERED conditional is a matching construct too. TDC's own reads a
    // named group instead: (?if{name=value:…}).
    expect(() => parseAdvancedRegexProgram('(?(1)a|b)')).toThrow(/not supported/);
  });

  it('rejects invalid backreferences', () => {
    expect(() => parseAdvancedRegexProgram('\\1([0-9])')).toThrow(/not generated yet/);
    expect(() => parseAdvancedRegexProgram('(A\\1)')).toThrow(/not generated yet/);
    expect(() => parseAdvancedRegexProgram('(A)\\2')).toThrow(/not generated yet/);
  });

  it('rejects malformed groups and classes', () => {
    expect(() => parseAdvancedRegexProgram('(abc')).toThrow(/expected "\)"/);
    expect(() => parseAdvancedRegexProgram('abc)')).toThrow(/unexpected "\)"/);
    expect(() => parseAdvancedRegexProgram('[abc')).toThrow(/expected "\]"/);
    expect(() => parseAdvancedRegexProgram('[]')).toThrow(/empty character classes/);
    expect(() => parseAdvancedRegexProgram('[^ -~]')).toThrow(/no available characters/);
  });

  it('rejects invalid character class ranges', () => {
    expect(() => parseAdvancedRegexProgram('[z-a]')).toThrow(/invalid character range/);
    expect(() => parseAdvancedRegexProgram('[\\d-a]')).toThrow(/single-character endpoints/);
  });

  it('rejects malformed quantifiers', () => {
    expect(() => parseAdvancedRegexProgram('*a')).toThrow(/has no target/);
    expect(() => parseAdvancedRegexProgram('?a')).toThrow(/has no target/);
    expect(() => parseAdvancedRegexProgram('{2}a')).toThrow(/has no target/);
    expect(() => parseAdvancedRegexProgram('A{,2}')).toThrow(/must start with a number/);
    expect(() => parseAdvancedRegexProgram('A{2,1}')).toThrow(/invalid quantifier bounds/);
    expect(() => parseAdvancedRegexProgram('A{2')).toThrow(/expected ","/);
    expect(() => parseAdvancedRegexProgram('A??')).toThrow(/lazy quantifiers/);
    expect(() => parseAdvancedRegexProgram('A{1,2}?')).toThrow(/lazy quantifiers/);
    expect(() => parseAdvancedRegexProgram('A{1}{2}')).toThrow(/stacked quantifiers/);
  });

  it('rejects unsupported escapes and dangling escapes', () => {
    expect(() => parseAdvancedRegexProgram('a\\')).toThrow(/dangling escape/);
    expect(() => parseAdvancedRegexProgram('\\n')).toThrow(/multiline escapes/);
    expect(() => parseAdvancedRegexProgram('[\\r]')).toThrow(/multiline escapes/);
    expect(() => parseAdvancedRegexProgram('\\p{L}')).toThrow(/Unicode property/);
    expect(() => parseAdvancedRegexProgram('[\\P]')).toThrow(/Unicode property/);
  });

  it('rejects malformed named alphabet escapes', () => {
    expect(() => parseAdvancedRegexProgram('\\a{}')).toThrow(/non-empty name/);
    expect(() => parseAdvancedRegexProgram('\\a{unknown}')).toThrow(/unknown alphabet/);
    expect(() => parseAdvancedRegexProgram('[\\a{unknown}]')).toThrow(/unknown alphabet/);
    expect(() => parseAdvancedRegexProgram('[\\a{kana.hiragana}-z]')).toThrow(
      /single-character endpoints/,
    );
  });

  it('rejects output longer than regex_max_length', () => {
    expect(() => parseAdvancedRegexProgram('[A-Z]{33}')).toThrow(/regex_max_length=32/);
    expect(parseAdvancedRegexProgram('[A-Z]{33}', { regexMaxLength: 33 }).maxLength).toBe(33);
  });

  it('rejects unsafe maximum-length arithmetic', () => {
    expect(() =>
      parseAdvancedRegexProgram('(?:a{9007199254740991}){2}', {
        regexMaxLength: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(/maximum length is too large/);
  });

  it('throws a typed error for invalid programs', () => {
    expect(() => parseAdvancedRegexProgram('[a-z]+')).toThrow(AdvancedRegexGeneratorError);
  });
});

/*
 * Named groups and conditionals — the two constructs that let ONE pattern hold a
 * value that agrees with another value it chose two characters earlier.
 *
 * Everything else in this generator decides a row from randomness alone. That is
 * why a pattern could describe an identifier or a postcode but never a title that
 * matches a sex, and why cross-field logic meant abandoning `advanced_regex` and
 * rebuilding the column as a `<switch>`.
 */
describe('named groups', () => {
  it('names a group without changing what it produces', () => {
    // Same seed, same pattern but for the name: a name is a label, not a draw.
    expect(generate('(?<letter>[ab])x', 20, 'named')).toEqual(generate('([ab])x', 20, 'named'));
  });

  it('is still a numbered group, so \\1 reads it', () => {
    for (const value of generate('(?<c>[ab])-\\1', 40)) {
      expect(value).toMatch(/^([ab])-\1$/);
    }
  });

  it('refuses a second group under the same name', () => {
    // Two groups under one name would make (?if{c=…}) a coin toss between them,
    // decided by whichever the parser happened to record last.
    expect(() => parseAdvancedRegexProgram('(?<c>a)(?<c>b)')).toThrow(/already used/);
  });

  it('refuses a name that is not a name', () => {
    expect(() => parseAdvancedRegexProgram('(?<9x>a)')).toThrow(/must start with a letter/);
    expect(() => parseAdvancedRegexProgram('(?<>a)')).toThrow(/needs a name/);
  });
});

describe('conditionals', () => {
  it('picks the branch the earlier group chose', () => {
    for (const value of generate(
      '(?<sex>(?%{50:male;50:female}))-(?if{sex=male:MR;sex=female:MS})',
    )) {
      expect(value).toMatch(/^(male-MR|female-MS)$/);
    }
  });

  it('takes the first matching branch, and * matches everything left', () => {
    const out = generate('(?<c>(?%{34:a;33:b;33:c}))-(?if{c=a:AAA;*:OTHER})', 300);
    for (const value of out) {
      expect(value).toMatch(/^(a-AAA|b-OTHER|c-OTHER)$/);
    }
    expect(countWhere(out, (v) => v.startsWith('a-'))).toBeGreaterThan(0);
    expect(countWhere(out, (v) => v.endsWith('-OTHER'))).toBeGreaterThan(0);
  });

  /*
   * The honest answer when the pattern says nothing about the value the row
   * actually holds. It is also why `*` exists — and why this is a test rather
   * than a footnote: an engine that quietly fell back to the FIRST branch would
   * produce a plausible file that pairs the wrong things.
   */
  it('produces nothing for a row no branch covers', () => {
    for (const value of generate('(?<c>[ab])-(?if{c=zzz:NEVER})', 20)) {
      expect(value).toMatch(/^[ab]-$/);
    }
  });

  it('nests weighted choices and further conditionals inside its branches', () => {
    for (const value of generate('(?<c>[ab])-(?if{c=a:(?%{50:A1;50:A2});*:B})', 200)) {
      expect(value).toMatch(/^(a-(A1|A2)|b-B)$/);
    }
    for (const value of generate('(?<c>[ab])(?<d>[xy])-(?if{c=a:(?if{d=x:AX;*:AY});*:B})', 200)) {
      expect(value).toMatch(/^(ax-AX|ay-AY|b[xy]-B)$/);
    }
  });

  it('leaves the weighted choice exact', () => {
    // The conditional reads the choice; it must not disturb the quota it drew.
    const counts = valueCounts(
      generate('(?<c>(?%{70:RU;20:US;10:DE}))-(?if{c=RU:east;*:west})', 1000),
    );
    expect(counts.get('RU-east')).toBe(700);
    expect(counts.get('US-west')).toBe(200);
    expect(counts.get('DE-west')).toBe(100);
  });

  /*
   * Generation runs left to right, so a group further along the pattern has
   * produced nothing to compare against — the branch could never be taken, and a
   * config asking for it meant the other order.
   */
  it('refuses a group named later in the pattern', () => {
    expect(() => parseAdvancedRegexProgram('(?if{c=a:X})(?<c>a)')).toThrow(
      /no \(\?<c>…\) group before it/,
    );
    expect(() => parseAdvancedRegexProgram('(?<c>(?if{c=a:X}))')).toThrow(
      /no \(\?<c>…\) group before it/,
    );
  });

  it('refuses a branch that reads nothing, and a conditional with no branch', () => {
    expect(() => parseAdvancedRegexProgram('(?<c>a)(?if{c:X})')).toThrow(/must read a group/);
    expect(() => parseAdvancedRegexProgram('(?<c>a)(?if{})')).toThrow(/at least one branch/);
    // Running off the end reports the same way the weighted choice beside it
    // does, which is the point: two constructs with one shape and one voice.
    expect(() => parseAdvancedRegexProgram('(?<c>a)(?if{c=a:X')).toThrow(/expected ";" or "}"/);
  });

  it('counts only the widest branch towards regex_max_length', () => {
    // A row takes exactly ONE branch, so the sum of them is not a width anything
    // can reach — measuring it that way refused patterns that fit.
    expect(
      parseAdvancedRegexProgram('(?<c>a)(?if{c=a:XXXXX;*:Y})', { regexMaxLength: 6 }).maxLength,
    ).toBe(6);
  });
});
