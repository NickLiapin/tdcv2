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
    expect(() => evaluateIf('cos(1) > 0', reg, 0)).toThrow(/unknown function "cos"/);
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
