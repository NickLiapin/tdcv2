/**
 * Rendered text -> typed value, per the column's declared type.
 * Empty means NULL (only for a nullable column); anything that cannot be
 * represented exactly is an error, never a silent rounding.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §5.
 */

import { describe, expect, it } from 'vitest';

import { parseColumnType } from '../../src/output/column-type.js';
import { convertValue } from '../../src/output/parquet/convert.js';

const t = (s: string) => parseColumnType(s);

describe('null handling', () => {
  it('empty text becomes NULL in a nullable column', () => {
    expect(convertValue('', t('int64|null'))).toBeNull();
  });

  it('empty text in a required column is an error', () => {
    expect(() => convertValue('', t('int64'))).toThrow(/empty value in a required column/);
  });
});

describe('bool', () => {
  it('accepts true/false and 1/0, case-insensitively', () => {
    expect(convertValue('true', t('bool'))).toBe(true);
    expect(convertValue('FALSE', t('bool'))).toBe(false);
    expect(convertValue('1', t('bool'))).toBe(true);
    expect(convertValue('0', t('bool'))).toBe(false);
  });

  it('rejects anything else', () => {
    expect(() => convertValue('yes', t('bool'))).toThrow(/not a boolean/);
  });
});

describe('integers', () => {
  it('parses int32 and rejects out-of-range', () => {
    expect(convertValue('42', t('int32'))).toBe(42);
    expect(convertValue('-2147483648', t('int32'))).toBe(-2147483648);
    expect(() => convertValue('2147483648', t('int32'))).toThrow(/out of range for int32/);
  });

  it('keeps int64 precision beyond what a double holds', () => {
    // 2^53 + 1 — a number would silently lose this.
    expect(convertValue('9007199254740993', t('int64'))).toBe(9007199254740993n);
  });

  it('rejects non-integers', () => {
    expect(() => convertValue('3.5', t('int64'))).toThrow(/not an integer/);
    expect(() => convertValue('abc', t('int64'))).toThrow(/not an integer/);
  });
});

describe('double', () => {
  it('parses decimal and scientific notation', () => {
    expect(convertValue('3.14', t('double'))).toBe(3.14);
    expect(convertValue('1e3', t('double'))).toBe(1000);
    expect(convertValue('-0.5', t('double'))).toBe(-0.5);
  });

  it('rejects non-numeric and non-finite', () => {
    expect(() => convertValue('abc', t('double'))).toThrow(/not a number/);
    expect(() => convertValue('Infinity', t('double'))).toThrow(/not a number/);
  });
});

describe('string and json pass through', () => {
  it('keeps the text as-is', () => {
    expect(convertValue('  hi  ', t('string'))).toBe('  hi  ');
    expect(convertValue('{"a":1}', t('json'))).toBe('{"a":1}');
  });
});

describe('date', () => {
  it('converts YYYY-MM-DD to days since the epoch', () => {
    expect(convertValue('1970-01-01', t('date'))).toBe(0);
    expect(convertValue('2020-05-14', t('date'))).toBe(18396);
  });

  it('rejects a malformed date', () => {
    expect(() => convertValue('14.05.2020', t('date'))).toThrow(/not a date/);
  });
});

describe('timestamp', () => {
  it('converts ISO-8601 to milliseconds since the epoch', () => {
    expect(convertValue('2020-05-14T00:00:00Z', t('timestamp'))).toBe(1589414400000n);
  });

  it('rejects a malformed timestamp', () => {
    expect(() => convertValue('not a time', t('timestamp'))).toThrow(/not a timestamp/);
  });
});

describe('decimal(p,s) — exact, never rounded', () => {
  it('scales by 10^s', () => {
    expect(convertValue('123.45', t('decimal(18,2)'))).toBe(12345n);
    expect(convertValue('123', t('decimal(18,2)'))).toBe(12300n);
    expect(convertValue('-1.5', t('decimal(18,2)'))).toBe(-150n);
    expect(convertValue('0.07', t('decimal(18,2)'))).toBe(7n);
  });

  it('refuses to lose digits instead of rounding', () => {
    expect(() => convertValue('123.456', t('decimal(18,2)'))).toThrow(/more decimal places/);
  });

  it('rejects values wider than the declared precision', () => {
    expect(() => convertValue('12345.67', t('decimal(4,2)'))).toThrow(/precision/);
  });

  it('rejects a non-numeric value', () => {
    expect(() => convertValue('abc', t('decimal(18,2)'))).toThrow(/not a decimal/);
  });
});

describe('uuid', () => {
  it('converts the canonical form to 16 bytes', () => {
    const v = convertValue('00112233-4455-6677-8899-aabbccddeeff', t('uuid'));
    expect(v).toBeInstanceOf(Uint8Array);
    expect([...(v as Uint8Array)]).toEqual([
      0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
      0xff,
    ]);
  });

  it('rejects a malformed uuid', () => {
    expect(() => convertValue('not-a-uuid', t('uuid'))).toThrow(/not a uuid/);
  });
});
