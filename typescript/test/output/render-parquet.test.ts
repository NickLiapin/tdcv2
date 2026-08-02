/**
 * End to end: a real .tdc config exported straight to Parquet, then read back
 * with hyparquet. This is the user-visible promise — declare types on <data>,
 * get a typed file that pandas/polars can open.
 */

import { parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { renderParquet } from '../../src/output/render-parquet.js';
import { parseStrict } from '../../src/parser/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

async function read(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const file = {
    byteLength: ab.byteLength,
    slice: (start: number, end?: number) => ab.slice(start, end),
  };
  return await parquetReadObjects({ file });
}

describe('config -> .parquet', () => {
  it('exports typed columns, including the anomaly ground-truth flag as a real bool', async () => {
    const cfg =
      `<tdc><env count="6" seed="demo" inject="\${{%}}">` +
      `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
      `<sequence name="Reading">` +
      `<gen type="number" value="40..60" anomaly="0.4" anomaly_factor="10" anomaly_flag="IsOutlier"/>` +
      `</sequence>` +
      `<sequence name="City"><gen type="text" value="Moscow,Berlin,Paris"/></sequence>` +
      `</env>` +
      `<block><line>` +
      `<data name="id" type="int64">\${{Id}}</data>` +
      `<data name="reading" type="int64">\${{Reading}}</data>` +
      `<data name="is_outlier" type="bool">\${{IsOutlier}}</data>` +
      `<data name="city" type="string">\${{City}}</data>` +
      `</line></block></tdc>`;

    const rows = await read(renderParquet(parseStrict(cfg), { now: NOW }));

    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r['id'])).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);
    // the ground-truth flag is a genuine boolean column, not the text "true"
    for (const row of rows) {
      expect(typeof row['is_outlier']).toBe('boolean');
      expect(typeof row['city']).toBe('string');
      expect(typeof row['reading']).toBe('bigint');
    }
    // and it still agrees with the value: flagged rows are the spiked ones
    for (const row of rows) {
      const spiked = (row['reading'] as bigint) >= 400n;
      expect(row['is_outlier']).toBe(spiked);
    }
  });

  it('turns missing= into a real NULL, not an empty string', async () => {
    const cfg =
      `<tdc><env count="8" seed="demo" inject="\${{%}}">` +
      `<sequence name="V"><gen type="number" value="10..99" missing="0.5"/></sequence>` +
      `</env>` +
      `<block><line><data name="v" type="int64|null">\${{V}}</data></line></block></tdc>`;

    const rows = await read(renderParquet(parseStrict(cfg), { now: NOW }));
    const values = rows.map((r) => r['v']);
    expect(values.some((v) => v === null)).toBe(true);
    expect(values.some((v) => typeof v === 'bigint')).toBe(true);
    // nothing came through as the empty string
    expect(values.some((v) => v === '')).toBe(false);
  });

  it('reports the column and row when a value does not fit its type', () => {
    const cfg =
      `<tdc><env count="3" seed="demo" inject="\${{%}}">` +
      `<sequence name="W"><gen type="text" value="abc"/></sequence>` +
      `</env>` +
      `<block><line><data name="n" type="int64">\${{W}}</data></line></block></tdc>`;
    expect(() => renderParquet(parseStrict(cfg), { now: NOW })).toThrow(
      /column "n", row 1: .*not an integer/,
    );
  });

  it('refuses a block with no named columns', () => {
    const cfg =
      `<tdc><env count="2" seed="demo" inject="\${{%}}">` +
      `<sequence name="A"><gen type="number" value="1..9"/></sequence></env>` +
      `<block><line><data>\${{A}}</data></line></block></tdc>`;
    expect(() => renderParquet(parseStrict(cfg), { now: NOW })).toThrow(
      /at least one named column/,
    );
  });
});
