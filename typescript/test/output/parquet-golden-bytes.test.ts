/**
 * Byte-identity guard for FLAT parquet output.
 *
 * List columns require touching the schema writer, the page body and the
 * column-chunk metadata — the three places every flat file also goes through.
 * This test pins the exact bytes of a flat file covering all nine scalar types
 * so that work cannot quietly change what existing configs produce.
 *
 * The hash is the hard assertion; the readable checks below it exist so a
 * failure says WHICH part moved instead of only "the bytes differ".
 *
 * If this fails and the change was deliberate, verify the new file still reads
 * correctly in an independent reader, then update the constants — never update
 * them just to make the test pass.
 *
 * History of deliberate changes:
 *   - 1076 → 1281 bytes when column statistics were added. Before updating, the
 *     written bounds were checked against the actual data (negatives, doubles,
 *     NULL counts and Cyrillic strings in UTF-8 byte order), not merely
 *     re-hashed.
 *   - 1281 → 1259 bytes when dictionary encoding arrived. The `city` column
 *     (3 distinct values over 7 rows) now carries a dictionary page, so the
 *     file got SMALLER. Verified by reading it back and by checking at 50k
 *     rows that high-cardinality columns correctly refuse a dictionary.
 *   - 1259 → 1144 bytes when snappy compression was turned on (per column,
 *     and only where it saves bytes — a tiny page can grow under framing). Verified by
 *     reading the file back through hyparquet (which decompresses with its own
 *     implementation) and, at 50k rows, by confirming every value, label and
 *     list survived: 5.70MB → 1.99MB with identical contents.
 * Spec: docs/specs/2026-07-19-repeated-values-lists-and-mix-ground-truth.md §7.
 *   - 1144 → 1162 bytes when `decimals=` began working on a plain range. It had
 *     been silently ignored there, so this very fixture's `p` (DOUBLE) and
 *     `money` (DECIMAL(18,2)) columns had only ever held whole numbers — the
 *     decimal path was never actually exercised. They now carry 467.12.
 *   - 1162 → 1191 bytes when `column_orders` was added to the footer: nine
 *     columns × three bytes, plus the list header. The statistics had been
 *     written and correct all along, and the spec forbids a reader from acting
 *     on them until this field declares the sort order. Verified in pyarrow
 *     (an independent reader, and not the one the tests below use): all seven
 *     rows, the NULL in `n`, the anomaly flags beside the spiked values, the
 *     decimals and the dates all read back, and the per-column min/max are now
 *     reported for every column pyarrow can type.
 */

import { createHash } from 'node:crypto';

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { renderParquet } from '../../src/output/render-parquet.js';
import { parseStrict } from '../../src/parser/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** Every scalar type we support, plus a NULL column and a ground-truth flag. */
const FLAT = `<tdc><env count="7" seed="golden-flat" inject="\${{%}}">
<sequence name="Id"><gen type="increment" value="1"/></sequence>
<sequence name="N"><gen type="number" value="10..99" missing="0.3"/></sequence>
<sequence name="P"><gen type="number" value="1..999" decimals="2"/></sequence>
<sequence name="C"><gen type="text" value="Moscow,Paris,Berlin" percent="50,30,20"/></sequence>
<sequence name="D"><gen type="date" range="1990-01-01..2000-12-31" format="YYYY-MM-DD"/></sequence>
<sequence name="K"><gen type="template" value="common.id.uuid"/></sequence>
<sequence name="R"><gen type="number" value="10..20" anomaly="0.4" anomaly_flag="F"/></sequence>
</env><block><line>
<data name="id">\${{Id}}</data><data name="n">\${{N}}</data><data name="p">\${{P}}</data>
<data name="city">\${{C}}</data><data name="born">\${{D}}</data><data name="key">\${{K}}</data>
<data name="r">\${{R}}</data><data name="flag">\${{F}}</data>
<data name="money" type="decimal(18,2)">\${{P}}</data>
</line></block></tdc>`;

const GOLDEN_SIZE = 1191;
const GOLDEN_SHA256 = '180e8e790c6fb18c0058ff83faf3ff19ec71464f7666c034f642f57fd11f1404';

const build = (): Uint8Array => renderParquet(parseStrict(FLAT), { now: NOW });

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

describe('flat parquet output is byte-for-byte unchanged', () => {
  it('matches the pinned bytes exactly', () => {
    const bytes = build();
    expect(bytes.length, 'file size changed').toBe(GOLDEN_SIZE);
    expect(createHash('sha256').update(bytes).digest('hex'), 'file contents changed').toBe(
      GOLDEN_SHA256,
    );
  });

  it('is stable across builds (nothing depends on a clock or a counter)', () => {
    expect(Buffer.from(build())).toEqual(Buffer.from(build()));
  });

  // --- diagnostics: these narrow down WHERE a byte change came from ----------

  it('declares one schema element per column, flat', () => {
    const meta = parquetMetadata(asArrayBuffer(build()));
    // Root + 9 leaves and nothing else: a stray group would mean a list wrapper
    // leaked into the flat path.
    expect(meta.schema).toHaveLength(10);
    expect(
      meta.schema.slice(1).map((c) => `${c.name}:${String(c.type)}:${String(c.repetition_type)}`),
    ).toMatchInlineSnapshot(`
      [
        "id:INT64:REQUIRED",
        "n:INT64:OPTIONAL",
        "p:DOUBLE:REQUIRED",
        "city:BYTE_ARRAY:REQUIRED",
        "born:INT32:REQUIRED",
        "key:FIXED_LEN_BYTE_ARRAY:REQUIRED",
        "r:INT64:REQUIRED",
        "flag:BOOLEAN:REQUIRED",
        "money:INT64:REQUIRED",
      ]
    `);
  });

  it('keeps every column chunk addressed by a single-element path', () => {
    const meta = parquetMetadata(asArrayBuffer(build()));
    for (const group of meta.row_groups) {
      for (const col of group.columns) {
        expect(col.meta_data?.path_in_schema).toHaveLength(1);
      }
    }
  });

  it('counts values and rows identically while the data is flat', () => {
    const meta = parquetMetadata(asArrayBuffer(build()));
    expect(Number(meta.num_rows)).toBe(7);
    for (const group of meta.row_groups) {
      expect(Number(group.num_rows)).toBe(7);
      for (const col of group.columns) expect(Number(col.meta_data?.num_values)).toBe(7);
    }
  });

  it('still round-trips through an independent reader', async () => {
    const ab = asArrayBuffer(build());
    const rows = (await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(7);
    expect(
      rows.some((r) => r['n'] === null),
      'missing= must survive as real NULLs',
    ).toBe(true);
    expect(typeof rows[0]?.['city']).toBe('string');
    expect(typeof rows[0]?.['flag']).toBe('boolean');
  });
});
