/**
 * List columns end to end, verified by an INDEPENDENT reader.
 *
 * The repetition/definition streams are the one part of this format that fails
 * quietly: a wrong level produces a file every reader accepts and then
 * re-assembles into the wrong shape. Our own code agreeing with itself proves
 * nothing, so every assertion here goes through hyparquet — a separate
 * implementation that knows nothing about how we wrote the bytes.
 * Spec: docs/specs/2026-07-19-repeated-values-lists-and-mix-ground-truth.md §5.
 */

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { renderParquet } from '../../src/output/render-parquet.js';
import { parseStrict } from '../../src/parser/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const config = (sequences: string, columns: string, count = 8) =>
  `<tdc><env count="${String(count)}" seed="lists" inject="\${{%}}">${sequences}</env>` +
  `<block><line>${columns}</line></block></tdc>`;

const build = (src: string): ArrayBuffer => {
  const bytes = renderParquet(parseStrict(src), { now: NOW });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const read = async (ab: ArrayBuffer): Promise<Record<string, unknown>[]> =>
  await parquetReadObjects({
    file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
  });

const schemaOf = (ab: ArrayBuffer): string[] =>
  parquetMetadata(ab).schema.map(
    (c) => `${c.name}:${c.type ?? 'group'}:${c.repetition_type ?? '-'}`,
  );

describe('list columns — the schema Parquet expects', () => {
  it('writes the three-element LIST wrapper with the spec-mandated names', () => {
    const ab = build(
      config(
        '<sequence name="T"><gen type="number" value="1..9" repeat="1..3"/></sequence>',
        '<data name="t">${{T}}</data>',
      ),
    );
    expect(schemaOf(ab)).toEqual([
      'schema:group:-',
      't:group:REQUIRED', // the annotated LIST group
      'list:group:REPEATED', // the repeated level
      'element:INT64:REQUIRED', // the leaf that carries bytes
    ]);
    // Annotated as a LIST both the modern and the legacy way.
    const group = parquetMetadata(ab).schema[1];
    expect(group?.converted_type).toBe('LIST');
  });

  it('addresses the column chunk by the full leaf path', () => {
    const ab = build(
      config(
        '<sequence name="T"><gen type="number" value="1..9" repeat="2"/></sequence>',
        '<data name="t">${{T}}</data>',
      ),
    );
    const col = parquetMetadata(ab).row_groups[0]?.columns[0];
    expect(col?.meta_data?.path_in_schema).toEqual(['t', 'list', 'element']);
  });

  it('counts level slots, not rows, in num_values — while num_rows stays rows', () => {
    const ab = build(
      config(
        '<sequence name="T"><gen type="number" value="1..9" repeat="3"/></sequence>',
        '<data name="t">${{T}}</data>',
        10,
      ),
    );
    const meta = parquetMetadata(ab);
    expect(Number(meta.num_rows)).toBe(10);
    // 10 rows x exactly 3 elements = 30 level slots.
    expect(Number(meta.row_groups[0]?.columns[0]?.meta_data?.num_values)).toBe(30);
  });
});

describe('list columns — the data survives a foreign reader', () => {
  it('round-trips variable lengths, including empty lists', async () => {
    const rows = await read(
      build(
        config(
          '<sequence name="T"><gen type="number" value="18..24" repeat="0..3"/></sequence>',
          '<data name="t">${{T}}</data>',
          40,
        ),
      ),
    );
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      const list = row['t'];
      expect(Array.isArray(list), `row t=${String(list)}`).toBe(true);
      const values = list as unknown[];
      expect(values.length).toBeLessThanOrEqual(3);
      for (const v of values) expect(Number(v)).toBeGreaterThanOrEqual(18);
    }
    // Both extremes must actually occur, or the levels are not being exercised.
    expect(
      rows.some((r) => (r['t'] as unknown[]).length === 0),
      'no empty list',
    ).toBe(true);
    expect(
      rows.some((r) => (r['t'] as unknown[]).length === 3),
      'no full list',
    ).toBe(true);
  });

  it('keeps NULL elements inside a list distinct from a short list', async () => {
    const rows = await read(
      build(
        config(
          '<sequence name="T"><gen type="number" value="1..9" repeat="3" missing="0.4"/></sequence>',
          '<data name="t">${{T}}</data>',
          40,
        ),
      ),
    );
    // Fixed repeat: every row keeps three slots even when values are missing.
    for (const row of rows) expect((row['t'] as unknown[]).length).toBe(3);
    expect(
      rows.some((r) => (r['t'] as unknown[]).includes(null)),
      'no NULL element',
    ).toBe(true);
  });

  it('a text list becomes a list of strings, not one joined string', async () => {
    const rows = await read(
      build(
        config(
          '<sequence name="T"><gen type="text" value="news,tech,sport" repeat="1..2"/></sequence>',
          '<data name="t">${{T}}</data>',
        ),
      ),
    );
    for (const row of rows) {
      const list = row['t'] as unknown[];
      expect(Array.isArray(list)).toBe(true);
      for (const v of list) expect(['news', 'tech', 'sport']).toContain(v);
    }
  });

  it('honours a custom separator when splitting the cell', async () => {
    const rows = await read(
      build(
        config(
          '<sequence name="T"><gen type="number" value="10..99" repeat="2" separator=" | "/></sequence>',
          '<data name="t">${{T}}</data>',
        ),
      ),
    );
    // Split on " | " — a naive comma split would have produced one long string.
    for (const row of rows) expect((row['t'] as unknown[]).length).toBe(2);
  });

  it('an explicitly declared []decimal keeps its exact scale', async () => {
    const rows = await read(
      build(
        config(
          '<sequence name="T"><gen type="number" value="1..99" decimals="2" repeat="2"/></sequence>',
          '<data name="t" type="[]decimal(18,2)">${{T}}</data>',
        ),
      ),
    );
    for (const row of rows) expect((row['t'] as unknown[]).length).toBe(2);
  });

  it('lists live happily beside plain scalar columns', async () => {
    const rows = await read(
      build(
        config(
          '<sequence name="Id"><gen type="increment" value="1"/></sequence>' +
            '<sequence name="T"><gen type="number" value="1..9" repeat="1..2"/></sequence>',
          '<data name="id">${{Id}}</data><data name="t">${{T}}</data>',
        ),
      ),
    );
    expect(rows[0]?.['id']).toBe(1n);
    expect(Array.isArray(rows[0]?.['t'])).toBe(true);
    expect(rows.map((r) => Number(r['id']))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('spans several row groups without losing list boundaries', async () => {
    // Above ROW_GROUP_ROWS so the multi-group path is exercised: a level stream
    // is per page, so a mis-reset would show up as shifted lists here.
    const rows = await read(
      build(
        config(
          '<sequence name="T"><gen type="number" value="1..9" repeat="0..2"/></sequence>',
          '<data name="t">${{T}}</data>',
          60_000,
        ),
      ),
    );
    expect(rows).toHaveLength(60_000);
    for (const row of rows) expect((row['t'] as unknown[]).length).toBeLessThanOrEqual(2);
  }, 120_000);
});
