import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_FUNCTION_NAMES, evaluateIf } from '../../src/expr/evaluate.js';
import { EXPR_FUNCTION_NAMES } from '../../src/validator/known.js';
import type { SequenceRegistry } from '../../src/sequence/types.js';

/**
 * Build a registry pre-seeded with the built-in `_count` for `size`
 * iterations, then overlaid with the caller-provided sequences.
 * Mirrors what `buildSequences` produces at runtime.
 */
function registry(
  values: Record<string, readonly (string | undefined)[]>,
  size = 10,
): SequenceRegistry {
  const out: Record<string, { name: string; values: readonly (string | undefined)[] }> = {
    _count: {
      name: '_count',
      values: Array.from({ length: size }, (_, i) => String(i + 1)),
    },
  };
  for (const [name, vals] of Object.entries(values)) {
    out[name] = { name, values: vals };
  }
  return out;
}

describe('evaluateIf — comparisons', () => {
  it('equality on a sequence value vs bare-identifier literal', () => {
    const reg = registry({ Gender: ['Male', 'Female'] });
    expect(evaluateIf('Gender == Male', reg, 0)).toBe(true);
    expect(evaluateIf('Gender == Male', reg, 1)).toBe(false);
  });

  it('inequality', () => {
    const reg = registry({ Gender: ['Male', 'Female'] });
    expect(evaluateIf('Gender != Male', reg, 1)).toBe(true);
  });

  it('numeric comparison against _count', () => {
    const reg = registry({});
    expect(evaluateIf('_count > 5', reg, 5)).toBe(true); // iteration 5 → _count = 6
    expect(evaluateIf('_count > 5', reg, 4)).toBe(false); // _count = 5
    expect(evaluateIf('_count <= 3', reg, 2)).toBe(true);
  });

  it('equality with numeric literal and string-sequence value', () => {
    const reg = registry({ Age: ['10', '20', '30'] });
    expect(evaluateIf('Age == 20', reg, 1)).toBe(true);
    expect(evaluateIf('Age == 30', reg, 0)).toBe(false);
  });

  it('equality with quoted string literal', () => {
    const reg = registry({ Role: ['admin', 'user'] });
    expect(evaluateIf('Role == "admin"', reg, 0)).toBe(true);
    expect(evaluateIf('Role == "guest"', reg, 0)).toBe(false);
  });
});

describe('evaluateIf — logical operators', () => {
  it('AND combines two conditions', () => {
    const reg = registry({ Gender: ['Male', 'Male'], Age: ['18', '30'] });
    expect(evaluateIf('Gender == Male && Age >= 18', reg, 0)).toBe(true);
    expect(evaluateIf('Gender == Female && Age >= 18', reg, 0)).toBe(false);
  });

  it('OR passes if any side is truthy', () => {
    const reg = registry({ Gender: ['Male', 'Female'] });
    expect(evaluateIf('Gender == Male || Gender == Female', reg, 0)).toBe(true);
    expect(evaluateIf('Gender == Male || Gender == Female', reg, 1)).toBe(true);
    expect(evaluateIf('Gender == Other || Gender == Nobody', reg, 0)).toBe(false);
  });

  it('NOT flips a boolean', () => {
    const reg = registry({ G: ['Male'] });
    expect(evaluateIf('!(G == Male)', reg, 0)).toBe(false);
    expect(evaluateIf('!(G == Female)', reg, 0)).toBe(true);
  });
});

describe('evaluateIf — arithmetic in context', () => {
  it('arithmetic expression in comparison', () => {
    const reg = registry({});
    expect(evaluateIf('_count * 2 == 10', reg, 4)).toBe(true); // _count=5 → 10
    expect(evaluateIf('_count - 1 > 0', reg, 1)).toBe(true); // _count=2 → 1
  });
});

describe('evaluateIf — compound references', () => {
  it('resolves dotted compound sequence names', () => {
    const reg = registry({ 'Person.FirstName': ['Alice'] });
    expect(evaluateIf('Person.FirstName == Alice', reg, 0)).toBe(true);
  });

  it('falls back to dotted string literals for unknown compound names', () => {
    const reg = registry({});
    expect(evaluateIf('Person.Unknown == "Person.Unknown"', reg, 0)).toBe(true);
  });
});

describe('evaluateIf — undefined sequence values', () => {
  it('parent-filtered undefined coerces to empty string', () => {
    const reg = registry({ Military: ['served', undefined, 'exempt'] });
    expect(evaluateIf('Military == served', reg, 0)).toBe(true);
    expect(evaluateIf('Military == served', reg, 1)).toBe(false);
    expect(evaluateIf('Military == ""', reg, 1)).toBe(true);
  });
});

describe('evaluateIf — the modulo operator', () => {
  it('picks out every second row', () => {
    const reg = registry({});
    expect(evaluateIf('_count % 2 == 0', reg, 1)).toBe(true); // row 2
    expect(evaluateIf('_count % 2 == 0', reg, 2)).toBe(false); // row 3
  });

  it('is EUCLIDEAN, like <mod> — and unlike the host language', () => {
    // JavaScript, Java, C# and Rust all answer −1 to `-3 % 2`; the compute
    // layer's <mod> answers 1, so `%` answers 1 too. One engine, one answer.
    const reg = registry({});
    expect(evaluateIf('(0 - 3) % 2 == 1', reg, 0)).toBe(true);
    expect(evaluateIf('(0 - 3) % 2 == 0 - 1', reg, 0)).toBe(false);
  });

  it('refuses a zero divisor rather than quietly yielding NaN', () => {
    const reg = registry({});
    expect(() => evaluateIf('_count % 0 == 0', reg, 0)).toThrow(/must not be zero/);
  });
});

describe('evaluateIf — functions', () => {
  it('the validator and the evaluator know the same names', () => {
    // A name that validates and does not evaluate makes `check` call a config
    // good and the run fall over — the one failure mode worth a whole test.
    expect(IMPLEMENTED_FUNCTION_NAMES).toEqual([...EXPR_FUNCTION_NAMES]);
  });

  it('abs, floor, ceil and trunc', () => {
    const reg = registry({ N: ['-7.5'] });
    expect(evaluateIf('abs(N) == 7.5', reg, 0)).toBe(true);
    expect(evaluateIf('floor(N) == 0 - 8', reg, 0)).toBe(true);
    expect(evaluateIf('ceil(N) == 0 - 7', reg, 0)).toBe(true);
    expect(evaluateIf('trunc(N) == 0 - 7', reg, 0)).toBe(true);
  });

  it('min and max take as many arguments as you give them', () => {
    const reg = registry({});
    expect(evaluateIf('min(3, 1, 2) == 1', reg, 0)).toBe(true);
    expect(evaluateIf('max(3, 1, 2) == 3', reg, 0)).toBe(true);
    expect(evaluateIf('min(5) == 5', reg, 0)).toBe(true);
  });

  it('round sends a half AWAY FROM ZERO, unlike any of the host languages', () => {
    // JS rounds a half toward +∞ (Math.round(-0.5) is -0); Python rounds to
    // even (round(0.5) is 0, round(2.5) is 2); Java rounds half up. TDC is
    // symmetric, so a column of negatives behaves like a column of positives.
    const reg = registry({});
    expect(evaluateIf('round(0.5) == 1', reg, 0)).toBe(true);
    expect(evaluateIf('round(0 - 0.5) == 0 - 1', reg, 0)).toBe(true);
    expect(evaluateIf('round(2.5) == 3', reg, 0)).toBe(true);
    expect(evaluateIf('round(0 - 2.5) == 0 - 3', reg, 0)).toBe(true);
  });

  it('composes with the rest of the language', () => {
    const reg = registry({ N: ['-9'] });
    expect(evaluateIf('abs(N) % 2 == 1 && max(abs(N), 3) == 9', reg, 0)).toBe(true);
  });

  it('throws on a name it does not implement', () => {
    const reg = registry({});
    expect(() => evaluateIf('besselj(1) > 0', reg, 0)).toThrow(/unknown function "besselj"/);
  });

  it('computes the transcendentals itself, to the same double every time', () => {
    // The literals are what TdcMath produces; a host libm would differ in the
    // last bit on some of them, and that is the whole point of the module.
    const reg = registry({});
    expect(evaluateIf('sqrt(2) == 1.4142135623730951', reg, 0)).toBe(true);
    expect(evaluateIf('exp(1) == 2.7182818284590455', reg, 0)).toBe(true);
    expect(evaluateIf('log(7) == 1.9459101490553132', reg, 0)).toBe(true);
    expect(evaluateIf('sin(1) == 0.8414709848078965', reg, 0)).toBe(true);
    expect(evaluateIf('cos(1000) == 0.5623790762907029', reg, 0)).toBe(true);
    expect(evaluateIf('pow(10, 3) == 1000', reg, 0)).toBe(true);
    expect(evaluateIf('atan(2) == 1.1071487177940904', reg, 0)).toBe(true);
    expect(evaluateIf('atan2(3, -4) == 2.498091544796509', reg, 0)).toBe(true);
    expect(evaluateIf('cbrt(10) == 2.154434690031884', reg, 0)).toBe(true);
    expect(evaluateIf('tanh(0.5) == 0.4621171572600098', reg, 0)).toBe(true);
    // cbrt is not pow(x, 1/3): one third is not a double, and a negative base
    // with a fractional exponent has no real answer at all.
    expect(evaluateIf('cbrt(-8) == -2', reg, 0)).toBe(true);
  });

  it('string predicates read the value as text, not as a number', () => {
    const reg = registry({ N: ['McDonald'], Z: ['10'] });
    expect(evaluateIf('starts_with(N, Mc)', reg, 0)).toBe(true);
    expect(evaluateIf('ends_with(N, ald)', reg, 0)).toBe(true);
    expect(evaluateIf('contains(N, Don)', reg, 0)).toBe(true);
    expect(evaluateIf('len(N) == 8', reg, 0)).toBe(true);
    // The one that proves the two families are separate: "10" is two characters.
    expect(evaluateIf('len(Z) == 2', reg, 0)).toBe(true);
  });

  it('len counts code points, so an emoji is one character', () => {
    const reg = registry({ E: ['😀ab'] });
    expect(evaluateIf('len(E) == 3', reg, 0)).toBe(true);
  });

  it('upper, lower and is_empty', () => {
    const reg = registry({ A: ['aB'], B: [''] });
    expect(evaluateIf('upper(A) == AB', reg, 0)).toBe(true);
    expect(evaluateIf('lower(A) == ab', reg, 0)).toBe(true);
    expect(evaluateIf('is_empty(B)', reg, 0)).toBe(true);
    expect(evaluateIf('is_empty(A)', reg, 0)).toBe(false);
  });
});

describe('evaluateIf — in, and the ternary', () => {
  it('in tests membership of a bare-word list', () => {
    const reg = registry({ C: ['CA'] });
    expect(evaluateIf('C in [US, CA, MX]', reg, 0)).toBe(true);
    expect(evaluateIf('C in [US, MX]', reg, 0)).toBe(false);
  });

  it('in compares as loosely as == does', () => {
    // The column is text; the list is numbers. `==` already bridges that, and
    // `in` must not be stricter or the two would disagree on the same pair.
    const reg = registry({ N: ['3'] });
    expect(evaluateIf('N in [1, 2, 3]', reg, 0)).toBe(true);
  });

  it('in binds like a comparison, so && groups around it', () => {
    const reg = registry({ C: ['CA'], N: ['5'] });
    expect(evaluateIf('C in [US, CA] && N == 5', reg, 0)).toBe(true);
    expect(evaluateIf('C in [US] && N == 5', reg, 0)).toBe(false);
  });

  it('the ternary picks a value, and the result is compared as usual', () => {
    const reg = registry({ N: ['1'] });
    expect(evaluateIf('(N > 40 ? N : 100) > 40', reg, 0)).toBe(true);
    expect(evaluateIf('(N > 40 ? N : 0) > 40', reg, 0)).toBe(false);
  });
});

describe('evaluateIf — errors', () => {
  it('throws on an operator that is still unsupported (bitwise)', () => {
    const reg = registry({});
    expect(() => evaluateIf('_count & 1 == 0', reg, 0)).toThrow(/operator/);
  });

  it('throws on unsupported computed member access', () => {
    const reg = registry({ Name: ['Alice'] });
    expect(() => evaluateIf('Name[0] == A', reg, 0)).toThrow(/computed member access/);
  });

  it('names the function it does not know, rather than refusing calls wholesale', () => {
    const reg = registry({});
    expect(() => evaluateIf('helper()', reg, 0)).toThrow(/unknown function "helper"/);
  });

  it('refuses to call anything but a plain name', () => {
    const reg = registry({ obj: ['x'] });
    expect(() => evaluateIf('obj.method(1)', reg, 0)).toThrow(/plain function name/);
  });
});

describe('whole numbers stay whole', () => {
  const reg = registry({ Id: ['9007199254740993'] });

  /**
   * A double holds every integer up to 2^53 and then starts skipping. Before
   * this, the two lines below answered true and 0 — silently, which for a data
   * generator is the worst kind of wrong: the run finishes and the file looks
   * fine.
   */
  it('tells two neighbouring whole numbers apart past 2^53', () => {
    expect(evaluateIf('Id == 9007199254740993', reg, 0)).toBe(true);
    expect(evaluateIf('Id == 9007199254740992', reg, 0)).toBe(false);
    expect(evaluateIf('9007199254740993 - 9007199254740992 == 1', reg, 0)).toBe(true);
    expect(evaluateIf('9007199254740993 > 9007199254740992', reg, 0)).toBe(true);
  });

  /**
   * The domain reaches -2^63, but its most negative value cannot be WRITTEN as
   * a literal: `-9223372036854775808` is unary minus applied to a magnitude one
   * past the largest positive, so the literal itself is out of range before the
   * sign is reached. Arithmetic gets there; the keyboard does not.
   */
  it('reaches the edge of the signed 64-bit domain', () => {
    expect(evaluateIf('9223372036854775807 - 1 == 9223372036854775806', reg, 0)).toBe(true);
    expect(evaluateIf('0 - 9223372036854775807 == -9223372036854775807', reg, 0)).toBe(true);
    expect(evaluateIf('-9223372036854775807 - 1 < -9223372036854775806', reg, 0)).toBe(true);
  });

  /**
   * Past the domain the answer is a refusal, in the same words the compute layer
   * uses, rather than a quiet slide back into floating point — which would be
   * the same silent wrongness arriving one step later.
   *
   * This is a RUN-TIME refusal, and the shared-case fixtures have no slot for
   * one: they describe what a config renders. So the five-way agreement on this
   * particular behaviour rests on each implementation's own tests, not on the
   * cross-language contract. Worth knowing before relying on it.
   */
  it('refuses rather than rounding when the domain runs out', () => {
    expect(() => evaluateIf('1000000000000000000 * 10 == 0', reg, 0)).toThrow(
      /integer overflow: 10000000000000000000 is outside the signed 64-bit range/,
    );
  });

  it('leaves division in floating point, always', () => {
    expect(evaluateIf('7 / 2 == 3.5', reg, 0)).toBe(true);
    expect(evaluateIf('10 / 2 == 5', reg, 0)).toBe(true);
  });

  it('keeps every rule the double path already had', () => {
    expect(evaluateIf('-4 % 3 == 2', reg, 0)).toBe(true);
    expect(evaluateIf('2 + 3 * 4 == 14', reg, 0)).toBe(true);
    expect(evaluateIf('-(5) == -5', reg, 0)).toBe(true);
    // A fraction is not a whole number and must not be treated as one.
    expect(evaluateIf('2.5 + 2.5 == 5', reg, 0)).toBe(true);
    expect(evaluateIf('sqrt(9007199254740993) > 94906265', reg, 0)).toBe(true);
  });
});

/**
 * Lists inside one row.
 *
 * A `repeat` list reaches an expression as its JOINED text — that is what the
 * renderer produced and what the registry holds — so `split` is the bridge and
 * everything else works on what it hands back.
 */
describe('within-row lists', () => {
  const reg = registry({
    Prices: ['12,40,101'],
    One: ['7'],
    Empty: [''],
    Word: ['abc'],
  });

  it('split cuts the joined text, and count says how many', () => {
    expect(evaluateIf('count(split(Prices, ",")) == 3', reg, 0)).toBe(true);
    // An empty subject is NO elements, not one blank one.
    expect(evaluateIf('count(split(Empty, ",")) == 0', reg, 0)).toBe(true);
    // An empty separator cuts into code points, the unit `len` counts.
    expect(evaluateIf('count(split(Word, "")) == len(Word)', reg, 0)).toBe(true);
  });

  it('at reads an element, counting from zero', () => {
    expect(evaluateIf('at(split(Prices, ","), 0) == 12', reg, 0)).toBe(true);
    expect(evaluateIf('at(split(Prices, ","), 2) == 101', reg, 0)).toBe(true);
  });

  it('sum stays whole while every element is whole', () => {
    expect(evaluateIf('sum(split(Prices, ",")) == 153', reg, 0)).toBe(true);
    // Past 2^53 a double would round; the whole-number path does not.
    const big = registry({ B: ['9007199254740992,1'] });
    expect(evaluateIf('sum(split(B, ",")) == 9007199254740993', big, 0)).toBe(true);
  });

  it('mean, median and stddev describe the list', () => {
    const five = registry({ N: ['2,4,4,4,5,5,7,9'] });
    expect(evaluateIf('mean(split(N, ",")) == 5', five, 0)).toBe(true);
    expect(evaluateIf('median(split(N, ",")) == 4.5', five, 0)).toBe(true);
    // POPULATION standard deviation — divided by 8, not by 7.
    expect(evaluateIf('stddev(split(N, ",")) == 2', five, 0)).toBe(true);
  });

  it('min and max take a list as readily as loose arguments', () => {
    expect(evaluateIf('max(split(Prices, ",")) == 101', reg, 0)).toBe(true);
    expect(evaluateIf('min(split(Prices, ",")) == 12', reg, 0)).toBe(true);
    expect(evaluateIf('max(1, 9, 4) == 9', reg, 0)).toBe(true);
  });

  it('join puts a list back together', () => {
    // The right side is QUOTED: a bare 12-40-101 is arithmetic, not a word.
    expect(evaluateIf('join(split(Prices, ","), "-") == "12-40-101"', reg, 0)).toBe(true);
  });

  /**
   * The four ways `at` used to answer with nothing.
   *
   * Only the first is a fact about the data: `repeat="1..4"` makes rows of
   * DIFFERENT lengths on purpose, so asking for the third element of a
   * two-element row is a question with a real, empty answer. The other three are
   * mistakes in the config, and each of them used to produce that same empty
   * string — so the run looked like it worked and the column came out blank.
   */
  it('past the end is empty, because rows may be short on purpose', () => {
    expect(evaluateIf('is_empty(at(split(Prices, ","), 9))', reg, 0)).toBe(true);
    // And count() is there to ask before reaching.
    expect(evaluateIf('count(split(Prices, ",")) > 9', reg, 0)).toBe(false);
  });

  it('a negative or fractional index is refused, not silently empty', () => {
    expect(() => evaluateIf('is_empty(at(split(Prices, ","), 0 - 1))', reg, 0)).toThrow(
      /at\(\) index must be a whole number of zero or more, not -1/,
    );
    expect(() => evaluateIf('is_empty(at(split(Prices, ","), 1.5))', reg, 0)).toThrow(/not 1\.5/);
  });

  it('an index that is not a number is refused', () => {
    expect(() => evaluateIf('is_empty(at(split(Prices, ","), "one"))', reg, 0)).toThrow(
      /at\(\) index must be a whole number of zero or more, not "one"/,
    );
  });

  it('at on a value that was never split is refused, and says how to fix it', () => {
    // The shape everybody writes first. `Prices` is the joined text, so this
    // asked for the second element of a one-element list and got nothing.
    expect(() => evaluateIf('is_empty(at(Prices, 1))', reg, 0)).toThrow(
      /at\(\) needs a list.*split it first/s,
    );
    expect(() => evaluateIf('at(One, 0) == 7', reg, 0)).toThrow(/at\(\) needs a list/);
  });

  it('the other list functions still read a single value as a list of one', () => {
    // Deliberate, and different from `at`: a total of one thing is that thing,
    // and `sum(Price)` should not need a rule remembered before every call.
    expect(evaluateIf('sum(One) == 7', reg, 0)).toBe(true);
    expect(evaluateIf('count(One) == 1', reg, 0)).toBe(true);
  });
});
