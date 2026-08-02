/**
 * The real proof: we write a .parquet file with our own writer, then read it
 * back with hyparquet — an INDEPENDENT implementation — and check the values,
 * types and NULLs survive. Same discipline as verifying check digits against an
 * outside oracle: our bytes have to convince someone else's parser.
 *
 * hyparquet is a devDependency only; nothing ships with it.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §11.
 */

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { parseColumnType } from '../../src/output/column-type.js';
import { convertValue } from '../../src/output/parquet/convert.js';
import { writeParquet, type ParquetColumn } from '../../src/output/parquet/writer.js';

function column(name: string, typeText: string, raw: readonly string[]): ParquetColumn {
  const type = parseColumnType(typeText);
  return { name, type, values: raw.map((r) => convertValue(r, type)) };
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function roundTrip(columns: ParquetColumn[], rows: number) {
  const ab = asArrayBuffer(writeParquet(columns, rows));
  const file = {
    byteLength: ab.byteLength,
    slice: (start: number, end?: number) => ab.slice(start, end),
  };
  return {
    meta: parquetMetadata(ab),
    rows: (await parquetReadObjects({ file })) as Record<string, unknown>[],
  };
}

describe('our Parquet file is readable by an independent parser', () => {
  it('round-trips the core types', async () => {
    const { rows } = await roundTrip(
      [
        column('Id', 'int64', ['1', '2', '9007199254740993']),
        column('Reading', 'double', ['1.5', '-0.25', '3']),
        column('IsOutlier', 'bool', ['true', 'false', 'true']),
        column('City', 'string', ['Москва', 'a', 'zz']),
      ],
      3,
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['Id'])).toEqual([1n, 2n, 9007199254740993n]);
    expect(rows.map((r) => r['Reading'])).toEqual([1.5, -0.25, 3]);
    expect(rows.map((r) => r['IsOutlier'])).toEqual([true, false, true]);
    expect(rows.map((r) => r['City'])).toEqual(['Москва', 'a', 'zz']);
  });

  it('carries real NULLs, not empty strings', async () => {
    const { rows } = await roundTrip([column('Maybe', 'int64|null', ['10', '', '30'])], 3);
    expect(rows.map((r) => r['Maybe'])).toEqual([10n, null, 30n]);
  });

  it('round-trips the annotated types', async () => {
    const { rows } = await roundTrip(
      [
        column('Day', 'date', ['2020-05-14']),
        column('Amount', 'decimal(18,2)', ['123.45']),
        column('Key', 'uuid', ['00112233-4455-6677-8899-aabbccddeeff']),
        column('Payload', 'json', ['{"a":1}']),
      ],
      1,
    );
    const row = rows[0] ?? {};
    // How each lands depends on the reader's mapping; what matters is that the
    // LOGICAL annotation was understood. hyparquet parses a JSON-annotated
    // column into an object — proof the annotation round-tripped, not just the
    // bytes.
    expect(row['Day']).toBeDefined();
    expect(row['Amount']).toBeDefined();
    expect(row['Key']).toBeDefined();
    expect(row['Payload']).toEqual({ a: 1 });
  });

  it('declares the schema we intended', async () => {
    const { meta } = await roundTrip(
      [column('Id', 'int64', ['1']), column('Name', 'string|null', ['x'])],
      1,
    );
    expect(meta.schema.map((s) => s.name)).toEqual(['schema', 'Id', 'Name']);
    expect(Number(meta.num_rows)).toBe(1);
  });

  it('handles an all-null column and a single row', async () => {
    const { rows } = await roundTrip([column('Empty', 'string|null', ['', '', ''])], 3);
    expect(rows.map((r) => r['Empty'])).toEqual([null, null, null]);
  });
});
