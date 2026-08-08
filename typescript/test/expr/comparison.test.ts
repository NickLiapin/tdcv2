/**
 * The whole comparison surface, one table per question.
 *
 * A TDC column is TEXT — every generator produces it, every built-in is it —
 * so "are these equal?" has two honest readings and each has its own operator:
 *
 *     ==   the same NUMBER, when both sides read as numbers
 *     ===  the same TEXT, printed and compared character by character
 *
 * These tests are written as tables rather than prose because the interesting
 * part is where the two ANSWERS DIFFER, and that is only visible side by side.
 * Every row below was run against the engine before `===` was fixed; the ones
 * that changed are marked, so none of them can pass vacuously.
 */

import { describe, expect, it } from 'vitest';

import { evaluateIf } from '../../src/expr/evaluate.js';
import type { SequenceRegistry } from '../../src/sequence/types.js';

/** Every value shape a column can hold that a comparison might trip on. */
const COLUMNS = {
  Empty: '',
  Zero: '0',
  ZeroPad: '00',
  ZeroDot: '0.0',
  One: '1',
  OnePad: '01',
  Neg: '-1',
  Plus: '+1',
  Float: '1.5',
  FloatWhole: '1.0',
  /** One past 2^53, where a double stops knowing which integer it is. */
  Big: '9007199254740993',
  Word: 'admin',
  TrueText: 'true',
  FalseText: 'false',
  Space: ' ',
  Hex: '0x10',
} as const;

function registry(extra: Record<string, string> = {}): SequenceRegistry {
  const out: Record<string, { name: string; values: readonly string[] }> = {
    _count: { name: '_count', values: ['1'] },
  };
  for (const [name, value] of Object.entries({ ...COLUMNS, ...extra })) {
    out[name] = { name, values: [value] };
  }
  return out;
}

const REG = registry();
const ask = (expr: string): boolean => evaluateIf(expr, REG, 0);

describe('=== asks whether both sides print the same characters', () => {
  /**
   * The defect this operator was fixed for. `N === 1` used to be false for
   * EVERY number on every row — a column is text and the literal beside it was
   * a number, and the host language's identity test answers "different types".
   * `check` passed, the run finished, the tagged rows were simply never there.
   */
  it('a column of digits matches the number written beside it', () => {
    expect(ask('One === 1')).toBe(true); // was false before the fix
    expect(ask('Zero === 0')).toBe(true); // was false
    expect(ask('Neg === -1')).toBe(true); // was false
    expect(ask('Float === 1.5')).toBe(true); // was false
    expect(ask('Big === 9007199254740993')).toBe(true); // was false
  });

  it('and the negation is now false where it used to be true on every row', () => {
    expect(ask('One !== 1')).toBe(false); // was true
    expect(ask('Big !== 9007199254740993')).toBe(false); // was true
  });

  it('text that reads as the same number but prints differently does not match', () => {
    expect(ask('OnePad === 1')).toBe(false); // "01"
    expect(ask('ZeroPad === 0')).toBe(false); // "00"
    expect(ask('ZeroDot === 0')).toBe(false); // "0.0"
    expect(ask('FloatWhole === 1')).toBe(false); // "1.0"
    expect(ask('Plus === 1')).toBe(false); // "+1"
    expect(ask('Space === 0')).toBe(false); // " "
  });

  it('an empty column is the empty text, and matches nothing but it', () => {
    expect(ask("Empty === ''")).toBe(true);
    expect(ask('Empty === 0')).toBe(false);
    expect(ask("Empty === '0'")).toBe(false);
  });

  it('a boolean prints as true or false, so it matches that text', () => {
    expect(ask("(1 == 1) === 'true'")).toBe(true); // was false
    expect(ask("(1 == 2) === 'false'")).toBe(true); // was false
    expect(ask('(1 == 1) === true')).toBe(true);
    expect(ask("TrueText === 'true'")).toBe(true);
    expect(ask("FalseText === 'false'")).toBe(true);
  });

  it('two literals that print the same match, whatever shape they arrived in', () => {
    expect(ask('1 === 1')).toBe(true);
    expect(ask('1 === 1.0')).toBe(true); // was false — 1.0 prints as "1"
    expect(ask("1 === '1'")).toBe(true); // was false
    expect(ask('admin === admin')).toBe(true);
    expect(ask("admin === 'admin'")).toBe(true);
    expect(ask('9007199254740993 === 9007199254740992')).toBe(false);
  });
});

describe('== asks whether both sides are the same number', () => {
  it('a column of digits against a number compares as numbers', () => {
    expect(ask('One == 1')).toBe(true);
    expect(ask('OnePad == 1')).toBe(true); // "01" IS one
    expect(ask('ZeroPad == 0')).toBe(true);
    expect(ask('ZeroDot == 0')).toBe(true);
    expect(ask('FloatWhole == 1')).toBe(true);
    expect(ask('Plus == 1')).toBe(true);
    expect(ask('Big == 9007199254740993')).toBe(true);
  });

  it('with no number on either side it falls back to text', () => {
    expect(ask('Word == admin')).toBe(true);
    expect(ask("Word == 'admin'")).toBe(true);
    expect(ask('Word == user')).toBe(false);
  });

  /**
   * The corners where reading text as a number is generous. All three are the
   * rule working as specified; they are pinned so a port cannot quietly answer
   * differently, and they are the reason the docs tell you to reach for `===`
   * when you mean the characters.
   */
  it('blank text reads as zero, and 0x10 reads as sixteen', () => {
    expect(ask('Space == 0')).toBe(true);
    expect(ask('Empty == 0')).toBe(true);
    expect(ask('Hex == 16')).toBe(true);
    // And none of them under ===, where nothing is read as anything.
    expect(ask('Space === 0')).toBe(false);
    expect(ask('Empty === 0')).toBe(false);
    expect(ask('Hex === 16')).toBe(false);
  });
});

describe('where the two operators disagree, and why', () => {
  /** Each row: the expression, what `==` says, what `===` says. */
  const TABLE: readonly (readonly [string, boolean, boolean])[] = [
    ['One @ 1', true, true],
    ['OnePad @ 1', true, false],
    ['ZeroPad @ 0', true, false],
    ['ZeroDot @ 0', true, false],
    ['FloatWhole @ 1', true, false],
    ['Plus @ 1', true, false],
    ['Empty @ 0', true, false],
    ['Space @ 0', true, false],
    ['Hex @ 16', true, false],
    ['Word @ admin', true, true],
    ['Big @ 9007199254740993', true, true],
    ['TrueText @ true', false, true],
  ];

  it.each(TABLE)('%s', (shape, loose, strict) => {
    expect(ask(shape.replace('@', '=='))).toBe(loose);
    expect(ask(shape.replace('@', '==='))).toBe(strict);
  });

  /**
   * `TrueText == true` deserves a word: `==` compares NUMBERS, and neither
   * "true" nor the boolean is one, so it is false. `===` compares the text both
   * print, and both print "true". A flag column is text, so the operator that
   * reads it is `===`.
   */
  it('a flag column matches the word, not the boolean', () => {
    expect(ask('TrueText == true')).toBe(false);
    expect(ask('TrueText === true')).toBe(true);
  });
});

describe('=== over every pair of columns is exactly text equality', () => {
  const names = Object.keys(COLUMNS) as (keyof typeof COLUMNS)[];

  /**
   * The invariant, stated once over all 256 pairs: `A === B` is true if and
   * only if the two columns hold the same characters. Nothing about types,
   * nothing about numbers, no exceptions — which is the whole claim the
   * documentation makes, checked rather than asserted.
   */
  it('matches a plain string comparison for all 256 pairs', () => {
    for (const a of names) {
      for (const b of names) {
        expect([a, b, ask(`${a} === ${b}`)]).toStrictEqual([a, b, COLUMNS[a] === COLUMNS[b]]);
      }
    }
  });

  it('!== is the exact negation, for all 256 pairs', () => {
    for (const a of names) {
      for (const b of names) {
        expect([a, b, ask(`${a} !== ${b}`)]).toStrictEqual([a, b, !ask(`${a} === ${b}`)]);
      }
    }
  });

  it('!= is the exact negation of ==, for all 256 pairs', () => {
    for (const a of names) {
      for (const b of names) {
        expect([a, b, ask(`${a} != ${b}`)]).toStrictEqual([a, b, !ask(`${a} == ${b}`)]);
      }
    }
  });
});

describe('what counts as true', () => {
  /**
   * Two texts are false — the empty one and `"false"` — and every other text is
   * true. That is Lua's and Ruby's rule (only "nothing" and "no" are false)
   * carried into a language whose only carrier is text.
   */
  const TRUTH: readonly (readonly [keyof typeof COLUMNS, boolean])[] = [
    ['Empty', false],
    ['FalseText', false],
    ['Zero', true],
    ['ZeroPad', true],
    ['ZeroDot', true],
    ['One', true],
    ['Neg', true],
    ['Word', true],
    ['TrueText', true],
    ['Space', true],
  ];

  it.each(TRUTH)('if="%s" is %s', (name, expected) => {
    expect(ask(name)).toBe(expected);
    expect(ask(`!${name}`)).toBe(!expected);
  });

  it('&& and || read their sides the same way', () => {
    expect(ask('Word && One')).toBe(true);
    expect(ask('Word && Empty')).toBe(false);
    expect(ask('Word && FalseText')).toBe(false);
    expect(ask('Empty || Zero')).toBe(true); // "0" is a value, so it is true
    expect(ask('Empty || FalseText')).toBe(false);
  });

  /**
   * The one place a bare name is genuinely ambiguous: a column of counts. The
   * name asks "did this column produce anything", which a zero did; asking
   * about the number needs the operator that means the number.
   */
  it('a zero count is a value, so ask about the number if that is the question', () => {
    expect(ask('Zero')).toBe(true);
    expect(ask('Zero != 0')).toBe(false);
    expect(ask('Zero !== "0"')).toBe(false);
  });
});

describe('the rest of the comparison surface', () => {
  it('ordering always reads both sides as numbers', () => {
    expect(ask('One < 2')).toBe(true);
    expect(ask('OnePad < 2')).toBe(true); // "01" is one
    expect(ask('Neg < 0')).toBe(true);
    expect(ask('Big > 9007199254740992')).toBe(true); // exact past 2^53
    expect(ask('Word < 1')).toBe(false); // not a number: no order either way
    expect(ask('Word > 1')).toBe(false);
  });

  it('in compares as loosely as ==', () => {
    expect(ask('One in [1, 2, 3]')).toBe(true);
    expect(ask('OnePad in [1, 2, 3]')).toBe(true);
    expect(ask('Word in [admin, user]')).toBe(true);
    expect(ask('Word in [user, guest]')).toBe(false);
  });

  /**
   * A list never matches under `===`, itself included. `in` is the operator for
   * lists; a list anywhere else is refused before the run by TDC259. Answering
   * false keeps all five implementations saying the same thing rather than
   * leaving each host's idea of list equality to decide.
   */
  it('a list is never strictly equal to anything', () => {
    expect(ask('[1, 2] === [1, 2]')).toBe(false);
    expect(ask('One === [1]')).toBe(false);
    expect(ask('[1, 2] !== [1, 2]')).toBe(true);
  });
});
