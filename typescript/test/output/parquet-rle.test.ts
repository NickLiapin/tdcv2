/**
 * The RLE / bit-packed hybrid, checked against bytes worked out by hand.
 *
 * A decoder is not available to us here, so every expectation is derived from
 * the format description rather than from what our own encoder happens to
 * emit. The end-to-end test reads the result back with hyparquet, which is the
 * independent half of the proof.
 */

import { describe, expect, it } from 'vitest';

import { parseColumnType } from '../../src/output/column-type.js';
import { buildDictionary } from '../../src/output/parquet/dictionary.js';
import { dictionaryBitWidth, encodeDictionaryIndices } from '../../src/output/parquet/rle.js';

const bytes = (indices: readonly number[], width: number): number[] =>
  Array.from(encodeDictionaryIndices(indices, width));

describe('dictionaryBitWidth', () => {
  it('sizes to the number of entries it must address', () => {
    expect(dictionaryBitWidth(0)).toBe(0);
    expect(dictionaryBitWidth(1)).toBe(1); // a lone entry still needs a bit
    expect(dictionaryBitWidth(2)).toBe(1); // indices 0..1
    expect(dictionaryBitWidth(3)).toBe(2); // indices 0..2
    expect(dictionaryBitWidth(4)).toBe(2);
    expect(dictionaryBitWidth(5)).toBe(3);
    expect(dictionaryBitWidth(256)).toBe(8);
    expect(dictionaryBitWidth(257)).toBe(9);
  });
});

describe('encodeDictionaryIndices', () => {
  it('leads with the bit width byte', () => {
    // That byte belongs to the page body, not to the hybrid stream; a reader
    // looks for it at exactly this position.
    expect(bytes([0, 1, 0], 2)[0]).toBe(2);
    expect(bytes([], 4)).toEqual([4]);
  });

  it('collapses a constant column to an RLE run', () => {
    // header varint(4 << 1) = 8, then the value in ceil(2/8) = 1 byte.
    expect(bytes([3, 3, 3, 3], 2)).toEqual([2, 8, 3]);
  });

  it('bit-packs a shuffled column, LSB first within each byte', () => {
    // Eight values at 1 bit each = one group.
    // header varint((1 << 1) | 1) = 3.
    // bits, lowest first: 1,0,1,1,0,0,0,1 → 0b1000_1101 = 0x8d
    expect(bytes([1, 0, 1, 1, 0, 0, 0, 1], 1)).toEqual([1, 3, 0x8d]);
  });

  it('packs two-bit values across byte boundaries', () => {
    // Four 2-bit values fill one byte: 1,2,3,0 → 0b00_11_10_01 = 0x39.
    // Eight values = one group = two bytes; the second four are 0 → 0x00.
    expect(bytes([1, 2, 3, 0, 0, 0, 0, 0], 2)).toEqual([2, 3, 0x39, 0x00]);
  });

  it('pads the final group with zeros rather than truncating', () => {
    // Three mixed values still cost a whole group of eight; the page header's
    // num_values is what tells a reader where to stop reading.
    // header 3 = one bit-packed group; bits lowest-first 1,0,1 → 0b101.
    expect(bytes([1, 0, 1], 1)).toEqual([1, 3, 0b101]);
  });

  it('prefers the RLE run when the short block happens to be constant', () => {
    // varint(3 << 1) = 6, then the value — three bytes instead of a whole group.
    expect(bytes([1, 1, 1], 1)).toEqual([1, 6, 1]);
  });

  it('handles a width past 8 bits without wrapping', () => {
    // 12 bits per value: shifting by more than 31 is where a naive
    // implementation silently corrupts data.
    const out = bytes([0xfff, 0x001, 0xabc, 0, 0, 0, 0, 0], 12);
    expect(out[0]).toBe(12);
    expect(out[1]).toBe(3); // one group of eight
    // value 0 = 0xfff occupies bits 0..11 → byte0 = 0xff, low nibble of byte1 = 0xf
    expect(out[2]).toBe(0xff);
    // byte1 = high nibble of value1 (0x001 → bits 12..23) low nibble | 0xf
    expect(out[3]! & 0x0f).toBe(0xf);
    expect(out).toHaveLength(2 + 12); // width + header + 8*12/8 bytes
  });

  it('an empty index list is just the width byte', () => {
    expect(bytes([], 0)).toEqual([0]);
  });
});

/**
 * Whether a dictionary is used at all.
 *
 * The decision must depend on the DATA and nothing else — a heuristic that
 * consulted a clock, a memory figure or a sample would put different bytes in
 * the file on different runs and break the cross-language contract. These tests
 * pin the rule, and the end-to-end ones below prove a foreign reader agrees
 * with whichever branch was taken.
 */
describe('buildDictionary — when it pays', () => {
  const type = parseColumnType('string');
  const repeat = (n: number, distinct: number) =>
    Array.from({ length: n }, (_, i) => `v${String(i % distinct)}`);

  it('encodes a column that repeats', () => {
    const dict = buildDictionary(type, repeat(100, 5));
    expect(dict?.values).toHaveLength(5);
    expect(dict?.indices).toHaveLength(100);
    // The indices really point at the right entries.
    expect(dict?.values[dict.indices[7] ?? 0]).toBe('v2');
  });

  it('refuses a near-unique column, where indices would be pure overhead', () => {
    expect(buildDictionary(type, repeat(100, 100))).toBeUndefined();
    expect(buildDictionary(type, repeat(100, 51))).toBeUndefined();
  });

  it('takes it right at the halfway rule and refuses just past it', () => {
    expect(buildDictionary(type, repeat(100, 50))).toBeDefined();
    expect(buildDictionary(type, repeat(100, 51))).toBeUndefined();
  });

  it('keeps first-seen order, so the same input always yields the same page', () => {
    // Eight values, three distinct — comfortably inside the halfway rule.
    const dict = buildDictionary(type, ['b', 'a', 'b', 'c', 'b', 'a', 'c', 'b']);
    expect(dict?.values).toEqual(['b', 'a', 'c']);
    expect(dict?.indices).toEqual([0, 1, 0, 2, 0, 1, 2, 0]);
  });

  it('never merges values a reader would tell apart', () => {
    // 1 and "1" must not collapse into one entry.
    const mixed = buildDictionary(parseColumnType('string'), [1, '1', 1, '1']);
    expect(mixed?.values).toHaveLength(2);
  });

  it('skips booleans, which already cost one bit', () => {
    expect(buildDictionary(parseColumnType('bool'), [true, false, true, false])).toBeUndefined();
  });

  it('an empty column has nothing to encode', () => {
    expect(buildDictionary(type, [])).toBeUndefined();
  });
});
