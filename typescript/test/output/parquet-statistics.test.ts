/**
 * Column statistics, checked against hand-computed bounds.
 *
 * A wrong bound is the quietest failure this format has: a reader trusts the
 * max, skips a row group that really did contain matching rows, and the query
 * comes back short with no error at all. So these tests target the places
 * where a plausible implementation goes wrong — non-ASCII ordering, NaN, and
 * negative numbers — rather than the happy path.
 */

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { renderParquet } from '../../src/output/render-parquet.js';
import { parseStrict } from '../../src/parser/index.js';

import { parseColumnType } from '../../src/output/column-type.js';
import { compareBytes, computeStatistics } from '../../src/output/parquet/statistics.js';

const type = (raw: string) => parseColumnType(raw);
const utf8 = new TextEncoder();

const minOf = (raw: string, values: readonly unknown[]) =>
  computeStatistics(type(raw), values as never, 0).minValue;
const maxOf = (raw: string, values: readonly unknown[]) =>
  computeStatistics(type(raw), values as never, 0).maxValue;

describe('compareBytes — unsigned, not signed, not UTF-16', () => {
  it('orders by unsigned byte value', () => {
    // 0x80 is NEGATIVE if bytes are read as signed — it must still sort above 0x7f.
    expect(compareBytes(Uint8Array.from([0x7f]), Uint8Array.from([0x80]))).toBeLessThan(0);
    expect(compareBytes(Uint8Array.from([0xff]), Uint8Array.from([0x00]))).toBeGreaterThan(0);
  });

  it('treats a prefix as smaller than what extends it', () => {
    expect(compareBytes(utf8.encode('ab'), utf8.encode('abc'))).toBeLessThan(0);
    expect(compareBytes(utf8.encode('abc'), utf8.encode('abc'))).toBe(0);
  });
});

describe('string statistics use UTF-8 byte order', () => {
  it('orders by UTF-8 bytes where JS string comparison would DISAGREE', () => {
    // The genuine divergence, not a case that merely looks like one.
    //   U+FFFD is one UTF-16 unit, 0xFFFD — above the emoji's leading
    //     surrogate 0xD83D, so JavaScript's `<` calls it the LARGER.
    //   In UTF-8 it is ef bf bd against the emoji's f0 9f 98 80, so by the
    //     order Parquet actually declares it is the SMALLER.
    // Using JS comparison here would write a max of U+FFFD, and a reader
    // hunting for the emoji would skip the row group that contains it.
    // (JS: '\uFFFD' > '\u{1F600}' is TRUE — the opposite of the answer below.)
    const values = ['\uFFFD', '\u{1F600}'];
    expect(maxOf('string', values)).toEqual(utf8.encode('\u{1F600}'));
    expect(minOf('string', values)).toEqual(utf8.encode('\uFFFD'));
  });

  it('puts ASCII below Cyrillic, as the byte order requires', () => {
    const values = ['apple', 'zebra', '\u0401\u043b\u043a\u0430', '\u042f\u0440'];
    expect(minOf('string', values)).toEqual(utf8.encode('apple'));
    expect(maxOf('string', values)).toEqual(utf8.encode('\u042f\u0440'));
  });

  it('a two-byte character outranks every ASCII one', () => {
    expect(maxOf('string', ['zzz', 'ё'])).toEqual(utf8.encode('ё'));
    expect(minOf('string', ['zzz', 'ё'])).toEqual(utf8.encode('zzz'));
  });

  it('encodes the bound without a length prefix', () => {
    // Statistics hold the raw value bytes; a length prefix here would make a
    // reader compare garbage.
    expect(maxOf('string', ['ab'])).toEqual(utf8.encode('ab'));
    expect(maxOf('string', ['ab'])).toHaveLength(2);
  });
});

describe('numeric statistics', () => {
  const readInt64 = (bytes: Uint8Array | undefined) =>
    bytes ? new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true) : undefined;
  const readDouble = (bytes: Uint8Array | undefined) =>
    bytes ? new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true) : undefined;

  it('handles negative integers as signed', () => {
    const values = [5n, -100n, 42n];
    expect(readInt64(minOf('int64', values))).toBe(-100n);
    expect(readInt64(maxOf('int64', values))).toBe(42n);
  });

  it('handles negative doubles', () => {
    expect(readDouble(minOf('double', [1.5, -2.25, 0]))).toBe(-2.25);
    expect(readDouble(maxOf('double', [1.5, -2.25, 0]))).toBe(1.5);
  });

  it('leaves NaN out of the bounds entirely', () => {
    // NaN compares false against everything; letting it become a bound would
    // make the chunk unskippable at best and wrongly skippable at worst.
    expect(readDouble(minOf('double', [NaN, 3, 1]))).toBe(1);
    expect(readDouble(maxOf('double', [NaN, 3, 1]))).toBe(3);
  });

  it('reports no bounds when every value is unusable', () => {
    const stats = computeStatistics(type('double'), [NaN] as never, 0);
    expect(stats.minValue).toBeUndefined();
    expect(stats.maxValue).toBeUndefined();
  });

  it('compares decimals on the unscaled integer', () => {
    // decimal(18,2): 1.05 is stored as 105, 1.5 as 150 — 150 is the larger.
    expect(readInt64(maxOf('decimal(18,2)', [105n, 150n]))).toBe(150n);
  });

  it('booleans order false below true', () => {
    expect(minOf('bool', [true, false])).toEqual(Uint8Array.from([0]));
    expect(maxOf('bool', [true, false])).toEqual(Uint8Array.from([1]));
  });
});

describe('null counting', () => {
  it('carries the caller-supplied NULL count through', () => {
    expect(computeStatistics(type('int64'), [1n] as never, 7).nullCount).toBe(7);
  });

  it('an all-NULL chunk has a count but no bounds', () => {
    const stats = computeStatistics(type('int64'), [], 12);
    expect(stats.nullCount).toBe(12);
    expect(stats.minValue).toBeUndefined();
  });

  it('a single value is both the min and the max', () => {
    expect(minOf('int64', [9n])).toEqual(maxOf('int64', [9n]));
  });
});

/**
 * Statistics as they land in a real file, read back by an independent reader.
 *
 * The core tests above prove the bounds are computed correctly; these prove
 * they survive Thrift encoding into the right field and mean the same thing to
 * somebody else's parser — which is the part that actually makes a reader skip
 * a row group.
 */
describe('statistics reach the file and match the data', () => {
  const build = (sequences: string, columns: string, count = 300): ArrayBuffer => {
    const src =
      `<tdc><env count="${String(count)}" seed="stats" inject="\${{%}}">${sequences}</env>` +
      `<block><line>${columns}</line></block></tdc>`;
    const bytes = renderParquet(parseStrict(src), { now: 0 });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  const readRows = (ab: ArrayBuffer): Promise<Record<string, unknown>[]> =>
    parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    });

  it('bounds and null count match the values actually written', async () => {
    const ab = build(
      '<sequence name="N"><gen type="number" value="-500..500"/></sequence>' +
        '<sequence name="G"><gen type="number" value="1..100" missing="0.3"/></sequence>',
      '<data name="n">${{N}}</data><data name="g">${{G}}</data>',
    );
    const rows = await readRows(ab);
    const cols = parquetMetadata(ab).row_groups[0]?.columns ?? [];

    const ns = rows.map((r) => Number(r['n']));
    expect(Number(cols[0]?.meta_data?.statistics?.min_value)).toBe(Math.min(...ns));
    expect(Number(cols[0]?.meta_data?.statistics?.max_value)).toBe(Math.max(...ns));
    expect(Number(cols[0]?.meta_data?.statistics?.null_count)).toBe(0);

    const gs = rows.map((r) => r['g']).filter((v) => v !== null) as unknown[];
    expect(Number(cols[1]?.meta_data?.statistics?.null_count)).toBe(rows.length - gs.length);
    expect(Number(cols[1]?.meta_data?.statistics?.min_value)).toBe(
      Math.min(...gs.map((v) => Number(v))),
    );
  });

  it('orders Cyrillic strings by UTF-8 bytes, as the format requires', () => {
    const ab = build(
      '<sequence name="C"><gen type="text" value="Москва,Ёлка,zebra,apple,Ярославль"/></sequence>',
      '<data name="c">${{C}}</data>',
    );
    const stats = parquetMetadata(ab).row_groups[0]?.columns[0]?.meta_data?.statistics;
    // ASCII sorts below every two-byte Cyrillic letter; among the Cyrillic ones
    // "Ё" (d0 81) is below "М" (d0 9c) is below "Я" (d0 af).
    expect(String(stats?.min_value)).toBe('apple');
    expect(String(stats?.max_value)).toBe('Ярославль');
  });

  it('a list column reports bounds over its ELEMENTS', async () => {
    const ab = build(
      '<sequence name="T"><gen type="number" value="10..90" repeat="1..3"/></sequence>',
      '<data name="t">${{T}}</data>',
    );
    const rows = await readRows(ab);
    const flat = rows.flatMap((r) => (r['t'] as unknown[]).map((v) => Number(v)));
    const stats = parquetMetadata(ab).row_groups[0]?.columns[0]?.meta_data?.statistics;
    expect(Number(stats?.min_value)).toBe(Math.min(...flat));
    expect(Number(stats?.max_value)).toBe(Math.max(...flat));
  });
});
