/**
 * Snappy, verified by decompressing with a decoder written independently from
 * the format description — not by feeding our own output back through our own
 * code, which would prove only self-consistency.
 *
 * A compressor that silently mangles one byte in a million is the worst
 * possible defect here: the file still opens, the schema still reads, and one
 * value somewhere is wrong. So these tests hammer the shapes where an encoder
 * actually breaks — overlapping copies, matches at the very end, runs longer
 * than one copy element can carry, and data that does not compress at all.
 */

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { describe, expect, it } from 'vitest';

import { renderParquet } from '../../src/output/render-parquet.js';
import { parseStrict } from '../../src/parser/index.js';

import { snappyCompress } from '../../src/output/parquet/snappy.js';

/**
 * A reference decompressor, written from the format description: varint length,
 * then elements whose low two tag bits pick literal (00) or one of the three
 * copy forms (01, 10, 11).
 */
function snappyDecompress(input: Uint8Array): Uint8Array {
  let at = 0;
  let expected = 0;
  let shift = 0;
  for (;;) {
    const byte = input[at++] ?? 0;
    expected += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  const out: number[] = [];
  while (at < input.length) {
    const tag = input[at++] ?? 0;
    if ((tag & 0x03) === 0) {
      let length = tag >>> 2;
      if (length >= 60) {
        const width = length - 59;
        length = 0;
        for (let i = 0; i < width; i++) length += (input[at + i] ?? 0) * Math.pow(256, i);
        at += width;
      }
      length += 1;
      for (let i = 0; i < length; i++) out.push(input[at + i] ?? 0);
      at += length;
      continue;
    }

    let length: number;
    let offset: number;
    if ((tag & 0x03) === 1) {
      length = ((tag >>> 2) & 0x07) + 4;
      offset = ((tag >>> 5) << 8) | (input[at++] ?? 0);
    } else if ((tag & 0x03) === 2) {
      length = (tag >>> 2) + 1;
      offset = (input[at] ?? 0) | ((input[at + 1] ?? 0) << 8);
      at += 2;
    } else {
      length = (tag >>> 2) + 1;
      offset =
        (input[at] ?? 0) |
        ((input[at + 1] ?? 0) << 8) |
        ((input[at + 2] ?? 0) << 16) |
        ((input[at + 3] ?? 0) << 24);
      at += 4;
    }
    // Byte at a time on purpose: a copy may overlap itself (offset < length),
    // which is how snappy expresses a repeating run.
    const from = out.length - offset;
    for (let i = 0; i < length; i++) out.push(out[from + i] ?? 0);
  }

  expect(out).toHaveLength(expected);
  return Uint8Array.from(out);
}

const roundTrip = (bytes: Uint8Array): void => {
  expect(Array.from(snappyDecompress(snappyCompress(bytes)))).toEqual(Array.from(bytes));
};

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('snappy round-trips', () => {
  it('empty input', () => {
    roundTrip(new Uint8Array(0));
    expect(snappyCompress(new Uint8Array(0))).toEqual(Uint8Array.from([0]));
  });

  it('input shorter than a match window', () => {
    for (const n of [1, 2, 3, 4, 5]) roundTrip(Uint8Array.from({ length: n }, (_, i) => i));
  });

  it('a long run of one byte, which needs several copy elements', () => {
    // One copy carries at most 64 bytes, so 1000 identical bytes exercise the
    // loop that keeps emitting until the match is spent.
    roundTrip(new Uint8Array(1000).fill(0x41));
  });

  it('overlapping copies (offset smaller than length)', () => {
    // "abababab…" is expressed as a copy reaching back two bytes and running
    // forward over what it is writing — the classic place a decoder or encoder
    // gets it wrong.
    roundTrip(bytesOf('ab'.repeat(500)));
  });

  it('realistic repeating text', () => {
    roundTrip(bytesOf('Moscow,Paris,Berlin,'.repeat(400)));
  });

  it('incompressible data stays correct', () => {
    // A deterministic pseudo-random stream — no matches to find, so this is
    // mostly literals and must still round-trip exactly.
    const noise = new Uint8Array(5000);
    let state = 12345;
    for (let i = 0; i < noise.length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      noise[i] = (state >>> 16) & 0xff;
    }
    roundTrip(noise);
  });

  it('a match that reaches the very last byte', () => {
    const data = new Uint8Array(200);
    data.fill(7, 0, 100);
    data.fill(7, 100, 200); // second half is a copy of the first, to the end
    roundTrip(data);
  });

  it('literal runs longer than the 60-byte short form', () => {
    // Forces the extended-length literal header (tags 60..63).
    const data = new Uint8Array(400);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
    roundTrip(data);
  });

  it('every length from 0 to 300, so no boundary is skipped', () => {
    for (let n = 0; n <= 300; n++) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i % 7) * 31;
      roundTrip(data);
    }
  });
});

describe('snappy actually compresses', () => {
  it('shrinks repetitive data substantially', () => {
    const data = bytesOf('Moscow,'.repeat(1000));
    const compressed = snappyCompress(data);
    expect(compressed.length).toBeLessThan(data.length / 10);
  });

  it('does not blow up incompressible data', () => {
    const noise = new Uint8Array(2000);
    let state = 999;
    for (let i = 0; i < noise.length; i++) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      noise[i] = (state >>> 16) & 0xff;
    }
    // Literal framing costs a few bytes per 60; well under 5% overhead.
    expect(snappyCompress(noise).length).toBeLessThan(noise.length * 1.05);
  });

  it('is deterministic — the same input always gives the same bytes', () => {
    const data = bytesOf('abc,def,abc,def,'.repeat(100));
    expect(Array.from(snappyCompress(data))).toEqual(Array.from(snappyCompress(data)));
  });
});

/**
 * Compression as it lands in a real file. hyparquet decompresses with its OWN
 * snappy implementation, so a file it reads correctly is a file any reader
 * reads correctly — which is the only claim worth making about a hand-written
 * compressor.
 */
describe('snappy in a real parquet file', () => {
  const build = (count: number): ArrayBuffer => {
    const src =
      `<tdc><env count="${String(count)}" seed="snap" inject="\${{%}}">` +
      `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
      `<sequence name="C"><gen type="text" value="Moscow,Paris,Berlin"/></sequence>` +
      `<sequence name="G"><gen type="number" value="1..100" missing="0.2"/></sequence>` +
      `<sequence name="T"><gen type="number" value="1..9" repeat="0..3"/></sequence>` +
      `</env><block><line>` +
      `<data name="id">\${{Id}}</data><data name="c">\${{C}}</data>` +
      `<data name="g">\${{G}}</data><data name="t">\${{T}}</data>` +
      `</line></block></tdc>`;
    const bytes = renderParquet(parseStrict(src), { now: 0 });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  it('never lets a chunk grow, and says which codec it used', () => {
    const meta = parquetMetadata(build(2000));
    const columns = meta.row_groups[0]?.columns ?? [];
    for (const col of columns) {
      const codec = String(col.meta_data?.codec);
      expect(['SNAPPY', 'UNCOMPRESSED']).toContain(codec);
      // Whichever branch was taken, the written form is never the larger one —
      // snappy adds framing bytes, and on an already-tiny page that framing can
      // exceed what it saves, so compression is skipped there.
      expect(Number(col.meta_data?.total_compressed_size)).toBeLessThanOrEqual(
        Number(col.meta_data?.total_uncompressed_size),
      );
      if (codec === 'SNAPPY') {
        expect(Number(col.meta_data?.total_compressed_size)).toBeLessThan(
          Number(col.meta_data?.total_uncompressed_size),
        );
      }
    }
    // The bulk column must genuinely compress, or nothing is being gained.
    expect(String(columns[0]?.meta_data?.codec)).toBe('SNAPPY');
  });

  it('a foreign reader decompresses every value, NULL and list intact', async () => {
    const ab = build(2000);
    const rows = (await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(2000);
    expect(rows.map((r) => Number(r['id']))).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1));
    for (const row of rows) {
      expect(['Moscow', 'Paris', 'Berlin']).toContain(row['c']);
      expect(Array.isArray(row['t'])).toBe(true);
    }
    expect(
      rows.some((r) => r['g'] === null),
      'NULLs must survive compression',
    ).toBe(true);
    expect(rows.some((r) => (r['t'] as unknown[]).length === 0)).toBe(true);
  });

  it('spans several row groups, each compressed on its own', async () => {
    const ab = build(60_000);
    expect(parquetMetadata(ab).row_groups.length).toBeGreaterThan(1);
    const rows = (await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(60_000);
    expect(Number(rows[59_999]?.['id'])).toBe(60_000);
  }, 120_000);
});
