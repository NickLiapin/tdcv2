/**
 * The two byte-level pieces of a Parquet data page: PLAIN-encoded values and
 * RLE definition levels (how NULL is expressed).
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §6.
 */

import { describe, expect, it } from 'vitest';

import { encodeLevels } from '../../src/output/parquet/levels.js';
import {
  plainBoolean,
  plainByteArray,
  plainDouble,
  plainFixed,
  plainInt32,
  plainInt64,
} from '../../src/output/parquet/plain.js';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('PLAIN values are little-endian', () => {
  it('int32', () => {
    expect(hex(plainInt32([1, -1]))).toBe('01 00 00 00 ff ff ff ff');
  });

  it('int64', () => {
    expect(hex(plainInt64([1n]))).toBe('01 00 00 00 00 00 00 00');
    expect(hex(plainInt64([-1n]))).toBe('ff ff ff ff ff ff ff ff');
  });

  it('double (IEEE-754)', () => {
    expect(hex(plainDouble([1]))).toBe('00 00 00 00 00 00 f0 3f');
  });

  it('byte array is length-prefixed', () => {
    expect(hex(plainByteArray(['ab']))).toBe('02 00 00 00 61 62');
  });

  it('fixed-length byte array has no prefix', () => {
    expect(hex(plainFixed([Uint8Array.from([0xde, 0xad])]))).toBe('de ad');
  });

  it('utf-8 is encoded by bytes, not characters', () => {
    // "я" is two bytes in UTF-8 -> length prefix must say 2.
    expect(hex(plainByteArray(['я']))).toBe('02 00 00 00 d1 8f');
  });
});

describe('PLAIN booleans are bit-packed, LSB first', () => {
  it('packs three values into one byte', () => {
    expect(hex(plainBoolean([true, false, true]))).toBe('05'); // 0b101
  });

  it('spills into a second byte past eight values', () => {
    const bits = [true, true, true, true, true, true, true, true, true];
    expect(hex(plainBoolean(bits))).toBe('ff 01');
  });

  it('encodes nothing for an empty column', () => {
    expect(hex(plainBoolean([]))).toBe('');
  });
});

describe('definition levels (RLE, bit width 1)', () => {
  it('collapses a run of present values', () => {
    // run of 3, value 1 -> header (3<<1)=6, then the value in one byte
    expect(hex(encodeLevels([1, 1, 1], 1))).toBe('06 01');
  });

  it('emits a run per change', () => {
    expect(hex(encodeLevels([1, 0, 1], 1))).toBe('02 01 02 00 02 01');
  });

  it('handles all-null', () => {
    expect(hex(encodeLevels([0, 0], 1))).toBe('04 00');
  });

  it('encodes nothing for no rows', () => {
    expect(hex(encodeLevels([], 1))).toBe('');
  });
});
