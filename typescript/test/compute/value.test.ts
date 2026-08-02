import { describe, expect, it } from 'vitest';

import {
  coerceInt,
  coerceStr,
  ComputeError,
  euclideanMod,
  floorDiv,
  guard64,
  int,
  INT64_MAX,
  INT64_MIN,
  list,
  parseIntStrict,
  str,
  valueToOutput,
} from '../../src/compute/value.js';

describe('int/guard64', () => {
  it('wraps a bigint as an int value', () => {
    expect(int(42n)).toEqual({ t: 'int', v: 42n });
  });

  it('accepts the exact 64-bit bounds', () => {
    expect(guard64(INT64_MAX)).toBe(INT64_MAX);
    expect(guard64(INT64_MIN)).toBe(INT64_MIN);
  });

  it('throws on overflow past the signed 64-bit range', () => {
    expect(() => guard64(INT64_MAX + 1n)).toThrow(ComputeError);
    expect(() => guard64(INT64_MIN - 1n)).toThrow(/overflow/);
  });
});

describe('coerceInt', () => {
  it('passes an int through', () => {
    expect(coerceInt(int(7n))).toBe(7n);
  });

  it('coerces a single digit character', () => {
    expect(coerceInt(str('0'))).toBe(0n);
    expect(coerceInt(str('9'))).toBe(9n);
  });

  it('rejects a multi-digit string and suggests <to_number>', () => {
    expect(() => coerceInt(str('12'))).toThrow(/to_number/);
  });

  it('rejects a non-numeric string', () => {
    expect(() => coerceInt(str('A'))).toThrow(/expected an integer/);
  });

  it('rejects a list', () => {
    expect(() => coerceInt(list([int(1n)]))).toThrow(/got a list/);
  });
});

describe('coerceStr / valueToOutput', () => {
  it('renders an int as decimal', () => {
    expect(coerceStr(int(123n))).toBe('123');
    expect(coerceStr(int(-5n))).toBe('-5');
  });

  it('returns a string unchanged', () => {
    expect(coerceStr(str('AB'))).toBe('AB');
  });

  it('coerceStr rejects a list, valueToOutput too', () => {
    expect(() => coerceStr(list([]))).toThrow(ComputeError);
    expect(() => valueToOutput(list([]))).toThrow(/not a list/);
  });

  it('valueToOutput renders int and str', () => {
    expect(valueToOutput(int(9n))).toBe('9');
    expect(valueToOutput(str('x'))).toBe('x');
  });
});

describe('parseIntStrict', () => {
  it('parses signed decimal strings', () => {
    expect(parseIntStrict('123')).toBe(123n);
    expect(parseIntStrict('-7')).toBe(-7n);
  });

  it('rejects non-numeric', () => {
    expect(() => parseIntStrict('1a')).toThrow(/not a valid integer/);
    expect(() => parseIntStrict('')).toThrow(ComputeError);
  });
});

describe('euclideanMod', () => {
  it('is non-negative for positive divisor', () => {
    expect(euclideanMod(7n, 3n)).toBe(1n);
    expect(euclideanMod(-1n, 3n)).toBe(2n);
    expect(euclideanMod(-7n, 3n)).toBe(2n);
  });

  it('result lies in [0, |b|) even for negative divisor', () => {
    expect(euclideanMod(-1n, -3n)).toBe(2n);
    expect(euclideanMod(7n, -3n)).toBe(1n);
  });

  it('throws on zero modulus', () => {
    expect(() => euclideanMod(1n, 0n)).toThrow(/must not be zero/);
  });
});

describe('floorDiv', () => {
  it('floors toward negative infinity', () => {
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-7n, 2n)).toBe(-4n);
    expect(floorDiv(7n, -2n)).toBe(-4n);
    expect(floorDiv(-7n, -2n)).toBe(3n);
  });

  it('throws on zero divisor', () => {
    expect(() => floorDiv(1n, 0n)).toThrow(/must not be zero/);
  });
});
