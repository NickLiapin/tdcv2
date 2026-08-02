/**
 * The RLE / bit-packed hybrid, as dictionary indices need it.
 *
 * Two shapes share one stream, told apart by the low bit of a varint header:
 *
 *   - **RLE run** — `varint(count << 1)` then the repeated value in
 *     `ceil(bitWidth/8)` bytes. Cheap when values repeat consecutively.
 *   - **Bit-packed run** — `varint((groups << 1) | 1)` then `groups × 8` values
 *     packed LSB-first at `bitWidth` bits each.
 *
 * Which one matters. A categorical column ("Moscow", "Paris", "Berlin") is
 * SHUFFLED across rows, so consecutive repeats are rare and an RLE-only encoder
 * would spend about two bytes per value — barely better than what it replaced.
 * Bit-packed spends `bitWidth` BITS: two bits per value for three categories,
 * a 16× difference on the same data. So bit-packing is the default here and RLE
 * is kept only for the genuinely constant case.
 *
 * Values are accumulated with multiplication rather than `<<` on purpose:
 * shifting past 31 bits wraps in JavaScript, and a run can hold up to
 * `bitWidth + 7` bits before it flushes.
 * Spec: docs/specs/2026-07-19-parquet-statistics-and-encodings.md §3
 */

import { encodeVarint } from './thrift.js';

/** Bits needed to address `count` distinct entries. `1` for a single entry. */
export function dictionaryBitWidth(count: number): number {
  if (count <= 1) return count === 0 ? 0 : 1;
  let bits = 0;
  while (1 << bits < count) bits++;
  return bits;
}

/** One RLE run: the same value repeated `count` times. */
function rleRun(value: number, count: number, bitWidth: number): number[] {
  const out: number[] = [...encodeVarint(count << 1)];
  const byteCount = Math.ceil(bitWidth / 8);
  let rest = value;
  for (let i = 0; i < byteCount; i++) {
    out.push(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** One bit-packed run covering every value, zero-padded to a multiple of 8. */
function bitPackedRun(values: readonly number[], bitWidth: number): number[] {
  const groups = Math.ceil(values.length / 8);
  const out: number[] = [...encodeVarint((groups << 1) | 1)];
  const padded = groups * 8;

  let acc = 0;
  let bits = 0;
  for (let i = 0; i < padded; i++) {
    acc += (values[i] ?? 0) * Math.pow(2, bits);
    bits += bitWidth;
    while (bits >= 8) {
      out.push(acc % 256);
      acc = Math.floor(acc / 256);
      bits -= 8;
    }
  }
  if (bits > 0) out.push(acc % 256);
  return out;
}

/**
 * Encode dictionary indices for a data page.
 *
 * The result begins with a single byte holding the bit width — that byte is
 * part of the page body, not of the hybrid stream, and a reader expects it
 * exactly there.
 */
export function encodeDictionaryIndices(indices: readonly number[], bitWidth: number): Uint8Array {
  const out: number[] = [bitWidth];
  if (indices.length > 0) {
    const first = indices[0] ?? 0;
    const constant = indices.every((i) => i === first);
    // A column holding one value all the way down collapses to a few bytes;
    // anything else packs, because shuffled categories have no runs to exploit.
    out.push(
      ...(constant ? rleRun(first, indices.length, bitWidth) : bitPackedRun(indices, bitWidth)),
    );
  }
  return Uint8Array.from(out);
}
