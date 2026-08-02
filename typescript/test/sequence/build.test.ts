import { describe, expect, it } from 'vitest';

import { createPrng } from '../../src/prng/prng.js';
import { buildSequences } from '../../src/sequence/build.js';
import type { SequenceSpec } from '../../src/sequence/types.js';

describe('buildSequences — root sequences', () => {
  it('includes the built-in _count sequence with 1-based values', () => {
    const reg = buildSequences([], 5, createPrng('x'), 'en', 0);
    expect(reg['_count']?.values).toEqual(['1', '2', '3', '4', '5']);
  });

  it('materializes a text sequence with exact percents', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Gender',
        gen: { type: 'text', attrs: { type: 'text', value: 'Male,Female', percent: '42,58' } },
      },
    ];
    const reg = buildSequences(specs, 100, createPrng('seed'), 'en', 0);
    const values = reg['Gender']?.values ?? [];
    expect(values.filter((v) => v === 'Male')).toHaveLength(42);
    expect(values.filter((v) => v === 'Female')).toHaveLength(58);
  });

  it('expands short percent masks before Hamilton distribution', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Kind',
        gen: { type: 'text', attrs: { type: 'text', value: 'A,B,C,D', percent: ',10,10' } },
      },
    ];
    const reg = buildSequences(specs, 100, createPrng('mask'), 'en', 0);
    const values = reg['Kind']?.values ?? [];
    expect(values.filter((v) => v === 'A')).toHaveLength(40);
    expect(values.filter((v) => v === 'B')).toHaveLength(40);
    expect(values.filter((v) => v === 'C')).toHaveLength(10);
    expect(values.filter((v) => v === 'D')).toHaveLength(10);
  });

  it('materializes a text sequence without percent as uniform draws', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Mood',
        gen: { type: 'text', attrs: { type: 'text', value: 'happy,sad,neutral' } },
      },
    ];
    const reg = buildSequences(specs, 200, createPrng('s'), 'en', 0);
    const seen = new Set(reg['Mood']?.values);
    expect(seen.size).toBeGreaterThan(1);
    for (const v of seen) {
      expect(['happy', 'sad', 'neutral']).toContain(v);
    }
  });

  it('is deterministic for the same seed', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'A',
        gen: { type: 'text', attrs: { type: 'text', value: 'x,y,z', percent: '33,33,34' } },
      },
    ];
    const a = buildSequences(specs, 50, createPrng('same'), 'en', 0);
    const b = buildSequences(specs, 50, createPrng('same'), 'en', 0);
    expect(a['A']?.values).toEqual(b['A']?.values);
  });

  it('materializes fixed-length digit-string numbers without a range', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Ticket',
        gen: { type: 'number', attrs: { type: 'number', length: '10', first_zero: 'true' } },
      },
    ];
    const reg = buildSequences(specs, 20, createPrng('digits'), 'en', 0);
    const values = reg['Ticket']?.values ?? [];
    expect(values).toHaveLength(20);
    for (const value of values) {
      expect(value).toHaveLength(10);
      expect(value).toMatch(/^\d{10}$/);
    }
  });

  it('materializes default digit numbers without attrs', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Digit',
        gen: { type: 'number', attrs: { type: 'number' } },
      },
    ];
    const reg = buildSequences(specs, 50, createPrng('default-digit-sequence'), 'en', 0);
    const values = reg['Digit']?.values ?? [];
    expect(values.some((v) => v === '0')).toBe(true);
    for (const value of values) {
      expect(value).toMatch(/^\d$/);
    }
  });

  it('materializes exact percentages across number length groups', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Len',
        gen: {
          type: 'number',
          attrs: { type: 'number', length: '2,10-12', percent: '85,15' },
        },
      },
    ];
    const reg = buildSequences(specs, 100, createPrng('length-groups'), 'en', 0);
    const values = (reg['Len']?.values ?? []).filter((v): v is string => v !== undefined);
    expect(values.filter((v) => v.length === 2)).toHaveLength(85);
    expect(values.filter((v) => v.length >= 10 && v.length <= 12)).toHaveLength(15);
  });

  it('materializes multi-range numbers', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Yearish',
        gen: {
          type: 'number',
          attrs: { type: 'number', value: '[0..100],[345..678],[1934..2026]' },
        },
      },
    ];
    const reg = buildSequences(specs, 200, createPrng('multi-range-sequence'), 'en', 0);
    const values = reg['Yearish']?.values ?? [];
    for (const value of values) {
      const n = Number(value);
      expect((n >= 0 && n <= 100) || (n >= 345 && n <= 678) || (n >= 1934 && n <= 2026)).toBe(true);
    }
  });

  it('materializes regex sequences', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Code',
        gen: {
          type: 'regex',
          attrs: { type: 'regex', value: '([0-9]{3})-[A-Z]{2}-\\1' },
        },
      },
    ];
    const reg = buildSequences(specs, 50, createPrng('regex-sequence'), 'en', 0);
    const values = reg['Code']?.values ?? [];
    expect(values).toHaveLength(50);
    for (const value of values) {
      expect(value).toMatch(/^([0-9]{3})-[A-Z]{2}-\1$/);
    }
  });

  it('materializes symbol sequences from named Unicode alphabets', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Kana',
        gen: {
          type: 'symbol',
          attrs: { type: 'symbol', alphabet: 'kana.hiragana', length: '8' },
        },
      },
    ];
    const reg = buildSequences(specs, 20, createPrng('symbol-sequence'), 'en', 0);
    const values = reg['Kana']?.values ?? [];
    expect(values).toHaveLength(20);
    for (const value of values) {
      expect(value).toMatch(/^[ぁ-ゖ]{8}$/u);
    }
  });

  it('materializes date sequences', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'GeneratedDate',
        gen: {
          type: 'date',
          attrs: {
            type: 'date',
            value: '2026-04-01..2026-04-03',
            format: 'YYYY-MM-DD',
          },
        },
      },
    ];
    const reg = buildSequences(specs, 20, createPrng('date-sequence'), 'en', 0);
    const values = reg['GeneratedDate']?.values ?? [];
    expect(values).toHaveLength(20);
    for (const value of values) {
      expect(['2026-04-01', '2026-04-02', '2026-04-03']).toContain(value);
    }
  });

  it('applies regex_max_length build options to regex sequences', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'LongCode',
        gen: {
          type: 'regex',
          attrs: { type: 'regex', value: '[A-Z0-9]{40}' },
        },
      },
    ];
    expect(() => buildSequences(specs, 1, createPrng('regex-limit-fail'), 'en', 0)).toThrow(
      /regex_max_length=32/,
    );

    const reg = buildSequences(specs, 3, createPrng('regex-limit-pass'), 'en', 0, {
      regexMaxLength: 40,
    });
    const values = reg['LongCode']?.values ?? [];
    expect(values).toHaveLength(3);
    for (const value of values) {
      expect(value).toMatch(/^[A-Z0-9]{40}$/);
    }
  });

  it('materializes advanced_regex weighted choices exactly in sequences', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'CountryCode',
        gen: {
          type: 'advanced_regex',
          attrs: { type: 'advanced_regex', value: '(?%{70:RU;20:US;10:DE})-[0-9]{2}' },
        },
      },
    ];
    const reg = buildSequences(specs, 100, createPrng('advanced-regex-sequence'), 'en', 0);
    const values = reg['CountryCode']?.values ?? [];
    expect(values.filter((value) => value?.startsWith('RU-'))).toHaveLength(70);
    expect(values.filter((value) => value?.startsWith('US-'))).toHaveLength(20);
    expect(values.filter((value) => value?.startsWith('DE-'))).toHaveLength(10);
    for (const value of values) {
      expect(value).toMatch(/^(RU|US|DE)-[0-9]{2}$/);
    }
  });

  it('materializes advanced_regex weighted choices over a parent-filtered subset', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Gender',
        gen: { type: 'text', attrs: { type: 'text', value: 'M,F', percent: '50,50' } },
      },
      {
        name: 'MaleCode',
        parent: 'Gender.M',
        gen: {
          type: 'advanced_regex',
          attrs: { type: 'advanced_regex', value: 'M-(?%{40:A;60:B})' },
        },
      },
    ];
    const reg = buildSequences(specs, 10, createPrng('advanced-parent'), 'en', 0);
    const gender = reg['Gender']?.values ?? [];
    const codes = reg['MaleCode']?.values ?? [];
    expect(gender.filter((value) => value === 'M')).toHaveLength(5);
    expect(codes.filter((value) => value === 'M-A')).toHaveLength(2);
    expect(codes.filter((value) => value === 'M-B')).toHaveLength(3);
    expect(codes.filter((value) => value === undefined)).toHaveLength(5);
  });
});

describe('buildSequences — parent-child', () => {
  it('applies child sequence only where parent produced the named value', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Gender',
        gen: { type: 'text', attrs: { type: 'text', value: 'Male,Female', percent: '42,58' } },
      },
      {
        name: 'Military',
        parent: 'Gender.Male',
        gen: { type: 'text', attrs: { type: 'text', value: 'yes,no', percent: '50,50' } },
      },
    ];
    const reg = buildSequences(specs, 100, createPrng('pc'), 'en', 0);
    const gender = reg['Gender']?.values ?? [];
    const military = reg['Military']?.values ?? [];
    for (let i = 0; i < 100; i++) {
      if (gender[i] === 'Male') {
        expect(military[i]).toMatch(/^(yes|no)$/);
      } else {
        expect(military[i]).toBeUndefined();
      }
    }
  });

  it('child percentages are computed over the parent subset, not the whole count', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Gender',
        gen: { type: 'text', attrs: { type: 'text', value: 'Male,Female', percent: '42,58' } },
      },
      {
        name: 'Prostate',
        parent: 'Gender.Male',
        gen: { type: 'text', attrs: { type: 'text', value: 'yes,no', percent: '20,80' } },
      },
    ];
    const reg = buildSequences(specs, 100, createPrng('pc2'), 'en', 0);
    const prostate = reg['Prostate']?.values ?? [];
    const filled = prostate.filter((v) => v !== undefined);
    expect(filled).toHaveLength(42); // exactly the Male count
    expect(filled.filter((v) => v === 'yes')).toHaveLength(8); // Hamilton on 42 at 20%
    expect(filled.filter((v) => v === 'no')).toHaveLength(34);
  });

  it('two siblings filtered by opposite parent values together cover every row', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Gender',
        gen: { type: 'text', attrs: { type: 'text', value: 'M,F', percent: '50,50' } },
      },
      {
        name: 'MaleOnly',
        parent: 'Gender.M',
        gen: { type: 'text', attrs: { type: 'text', value: 'mv' } },
      },
      {
        name: 'FemaleOnly',
        parent: 'Gender.F',
        gen: { type: 'text', attrs: { type: 'text', value: 'fv' } },
      },
    ];
    const reg = buildSequences(specs, 50, createPrng('sib'), 'en', 0);
    for (let i = 0; i < 50; i++) {
      const m = reg['MaleOnly']?.values[i];
      const f = reg['FemaleOnly']?.values[i];
      // Exactly one of the two is defined per row; never both, never neither.
      expect((m === undefined) !== (f === undefined)).toBe(true);
    }
  });

  it('throws when a parent reference cannot be resolved', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Child',
        parent: 'NotYet.Defined',
        gen: { type: 'text', attrs: { type: 'text', value: 'x,y' } },
      },
    ];
    expect(() => buildSequences(specs, 10, createPrng('z'), 'en', 0)).toThrow(/unknown parent/);
  });

  it('bare "ParentName" without .Value applies to every row the parent filled', () => {
    // Useful for compound-style hierarchy where the child simply
    // depends on the parent existing, not on a specific value.
    const specs: SequenceSpec[] = [
      {
        name: 'Root',
        gen: { type: 'text', attrs: { type: 'text', value: 'x,y', percent: '50,50' } },
      },
      {
        name: 'Any',
        parent: 'Root',
        gen: { type: 'text', attrs: { type: 'text', value: 'a,b' } },
      },
    ];
    const reg = buildSequences(specs, 20, createPrng('bare'), 'en', 0);
    const any = reg['Any']?.values ?? [];
    expect(any.filter((v) => v !== undefined)).toHaveLength(20);
  });
});
