import { describe, expect, it } from 'vitest';

import { evaluateIf } from '../../src/expr/evaluate.js';
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

describe('evaluateIf — errors', () => {
  it('throws on unsupported operator (modulo, nullish, etc.)', () => {
    const reg = registry({});
    expect(() => evaluateIf('_count % 2 == 0', reg, 0)).toThrow(/operator/);
  });

  it('throws on unsupported computed member access', () => {
    const reg = registry({ Name: ['Alice'] });
    expect(() => evaluateIf('Name[0] == A', reg, 0)).toThrow(/computed member access/);
  });

  it('throws on unsupported call expressions', () => {
    const reg = registry({});
    expect(() => evaluateIf('helper()', reg, 0)).toThrow(/unsupported expression node/);
  });
});
