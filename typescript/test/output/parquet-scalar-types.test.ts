/**
 * The scalar types added after the first ten: float, float16, enum and the
 * unsigned integers.
 *
 * Each is a physical type plus an annotation, so the risk is not "does it
 * write" but "does it mean what it claims". Two things get specific attention:
 *
 *   - a narrower float must actually LOSE the precision it cannot hold, and
 *     the value we keep in memory must be the rounded one — otherwise the
 *     column statistics would describe numbers the file does not contain;
 *   - an unsigned 64-bit value above 2^63 is stored as wrapped signed bits, so
 *     it must be COMPARED unsigned. Comparing it signed would make the largest
 *     values look like the smallest and put a wrong bound in the footer.
 */

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { parseColumnType } from '../../src/output/column-type.js';
import { convertValue } from '../../src/output/parquet/convert.js';
import { halfBits, halfToNumber } from '../../src/output/parquet/plain.js';
import { computeStatistics } from '../../src/output/parquet/statistics.js';
import { renderParquet } from '../../src/output/render-parquet.js';
import { parseStrict } from '../../src/parser/index.js';

const convert = (raw: string, type: string) => convertValue(raw, parseColumnType(type));

describe('half precision (float16)', () => {
  it('round-trips the values it can hold exactly', () => {
    for (const v of [0, 1, -1, 0.5, -2.5, 1024, -1024, 65504]) {
      expect(halfToNumber(halfBits(v)), String(v)).toBe(v);
    }
  });

  it('really loses precision — it is 16 bits, not a relabelled double', () => {
    // 1/3 cannot be held in 10 mantissa bits; the nearest half is 0.333251953125.
    expect(halfToNumber(halfBits(1 / 3))).toBeCloseTo(0.33325, 5);
    expect(halfToNumber(halfBits(1 / 3))).not.toBe(1 / 3);
    // Consecutive integers stop being distinguishable past 2048.
    expect(halfToNumber(halfBits(2049))).toBe(2048);
  });

  it('saturates to infinity beyond its range, and we refuse that', () => {
    expect(halfToNumber(halfBits(100000))).toBe(Infinity);
    expect(() => convert('100000', 'float16')).toThrow(/out of range for float16/);
  });

  it('keeps signed zero and subnormals', () => {
    expect(Object.is(halfToNumber(halfBits(-0)), -0)).toBe(true);
    // 2^-24 is the smallest positive subnormal a half can represent.
    expect(halfToNumber(halfBits(Math.pow(2, -24)))).toBe(Math.pow(2, -24));
  });
});

describe('conversion stores what will be written, not the input', () => {
  it('float rounds to single precision on the way in', () => {
    // 0.1 has no exact float32 form; keeping the double would make the
    // statistics describe a number the file does not hold.
    expect(convert('0.1', 'float')).toBe(Math.fround(0.1));
    expect(convert('0.1', 'float')).not.toBe(0.1);
  });

  it('float refuses a value beyond single-precision range', () => {
    expect(() => convert('1e40', 'float')).toThrow(/out of range for float/);
  });

  it('float16 rounds on the way in too', () => {
    expect(convert('0.1', 'float16')).toBe(halfToNumber(halfBits(0.1)));
  });
});

describe('unsigned integers', () => {
  it('refuses a negative value outright', () => {
    expect(() => convert('-1', 'uint8')).toThrow(/negative/);
    expect(() => convert('-1', 'uint64')).toThrow(/negative/);
  });

  it('enforces the declared width', () => {
    expect(convert('255', 'uint8')).toBe(255);
    expect(() => convert('256', 'uint8')).toThrow(/out of range for uint8/);
    expect(convert('65535', 'uint16')).toBe(65535);
    expect(() => convert('65536', 'uint16')).toThrow(/out of range/);
  });

  it('wraps values above the signed limit into the storage slot', () => {
    // 2^63 does not fit a signed int64; it is stored as the corresponding
    // negative bit pattern, which the UINT_64 annotation tells readers to undo.
    expect(convert('9223372036854775808', 'uint64')).toBe(-9223372036854775808n);
    expect(() => convert('18446744073709551616', 'uint64')).toThrow(/out of range/);
  });

  it('compares unsigned, so huge values are the LARGEST not the smallest', () => {
    const type = parseColumnType('uint64');
    // 2^64-1 stored as -1n; a signed comparison would call it the minimum.
    const values = [convert('1', 'uint64'), convert('18446744073709551615', 'uint64')];
    const stats = computeStatistics(type, values, 0);
    const read = (b: Uint8Array | undefined) =>
      b ? new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true) : undefined;
    expect(read(stats.minValue)).toBe(1n);
    expect(read(stats.maxValue)).toBe(-1n); // the wrapped 2^64-1
  });
});

describe('the new types in a real file', () => {
  const build = (columns: string, sequences: string): ArrayBuffer => {
    const src =
      `<tdc><env count="4" seed="types" inject="\${{%}}">${sequences}</env>` +
      `<block><line>${columns}</line></block></tdc>`;
    const bytes = renderParquet(parseStrict(src), { now: 0 });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  it('declares each one with the annotation a reader looks for', () => {
    const ab = build(
      '<data name="f32" type="float">${{N}}</data>' +
        '<data name="f16" type="float16">${{N}}</data>' +
        '<data name="u8" type="uint8">${{N}}</data>' +
        '<data name="u64" type="uint64">${{N}}</data>' +
        '<data name="col" type="enum">${{T}}</data>',
      '<sequence name="N"><gen type="number" value="10..200"/></sequence>' +
        '<sequence name="T"><gen type="text" value="RED,BLUE"/></sequence>',
    );
    const schema = parquetMetadata(ab).schema.slice(1);
    expect(schema.map((c) => `${c.name}:${String(c.type)}`)).toEqual([
      'f32:FLOAT',
      'f16:FIXED_LEN_BYTE_ARRAY',
      'u8:INT32',
      'u64:INT64',
      'col:BYTE_ARRAY',
    ]);
    expect(schema[1]?.type_length).toBe(2);
    expect(schema[2]?.converted_type).toBe('UINT_8');
    expect(schema[3]?.converted_type).toBe('UINT_64');
    expect(schema[4]?.converted_type).toBe('ENUM');
    // The INTEGER logical type must carry width AND signedness; bitWidth is an
    // i8 in Thrift, so writing it as an i32 would corrupt every later field.
    expect(schema[2]?.logical_type).toEqual({ type: 'INTEGER', bitWidth: 8, isSigned: false });
  });

  it('an independent reader gets the values back', async () => {
    const ab = build(
      '<data name="f32" type="float">${{N}}</data><data name="u8" type="uint8">${{N}}</data>',
      '<sequence name="N"><gen type="number" value="10..200"/></sequence>',
    );
    const rows = (await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(Number(row['f32'])).toBe(Number(row['u8']));
      expect(Number(row['u8'])).toBeGreaterThanOrEqual(10);
      expect(Number(row['u8'])).toBeLessThanOrEqual(200);
    }
  });
});

/**
 * Rounding ties, checked against the IEEE-754 default (half to even).
 *
 * The widely-copied half-precision snippet rounds half UP, which disagrees
 * here. Ties are common in generated data — round numbers are exactly what a
 * generator produces — so the wrong rule would put different bytes in our files
 * than every other Parquet writer puts in theirs.
 */
describe('float16 rounds ties to even', () => {
  it('resolves an exact tie towards the even neighbour', () => {
    // Past 2048 the representable values step by 2, so 2049 sits exactly
    // between 2048 and 2050. Even wins: 2048.
    expect(halfToNumber(halfBits(2049))).toBe(2048);
    // 2051 sits between 2050 and 2052; even wins again: 2052.
    expect(halfToNumber(halfBits(2051))).toBe(2052);
  });

  it('still rounds a clear majority the normal way', () => {
    expect(halfToNumber(halfBits(2049.5))).toBe(2050);
    expect(halfToNumber(halfBits(2048.4))).toBe(2048);
  });

  it('carries correctly when rounding crosses a power of two', () => {
    // 2047.9 must round up to 2048 and take the exponent with it.
    expect(halfToNumber(halfBits(2047.9))).toBe(2048);
  });

  it('rounds up into infinity only at the very top', () => {
    expect(halfToNumber(halfBits(65504))).toBe(65504); // largest finite half
    expect(halfToNumber(halfBits(65520))).toBe(Infinity); // first tie that carries out
  });
});
