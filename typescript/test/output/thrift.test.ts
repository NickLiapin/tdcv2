/**
 * Thrift Compact Protocol writer — the encoding Parquet uses for its page
 * headers and footer. Byte-exact tests against values derived from the protocol
 * spec, because a single wrong byte makes the whole file unreadable.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §6.
 */

import { describe, expect, it } from 'vitest';

import {
  CompactType,
  CompactWriter,
  encodeVarint,
  zigzag32,
  zigzag64,
} from '../../src/output/parquet/thrift.js';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

describe('varint (ULEB128)', () => {
  it('encodes small and multi-byte values', () => {
    expect([...encodeVarint(0)]).toEqual([0x00]);
    expect([...encodeVarint(1)]).toEqual([0x01]);
    expect([...encodeVarint(127)]).toEqual([0x7f]);
    expect([...encodeVarint(128)]).toEqual([0x80, 0x01]);
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02]);
    expect([...encodeVarint(16384)]).toEqual([0x80, 0x80, 0x01]);
  });

  it('handles large values (7 bits per byte)', () => {
    // 2^28 needs 29 bits -> ceil(29/7) = 5 bytes, only the top group non-zero.
    expect([...encodeVarint(2n ** 28n)]).toEqual([0x80, 0x80, 0x80, 0x80, 0x01]);
  });
});

describe('zigzag', () => {
  it('maps signed to unsigned as the spec does', () => {
    expect(zigzag32(0)).toBe(0);
    expect(zigzag32(-1)).toBe(1);
    expect(zigzag32(1)).toBe(2);
    expect(zigzag32(-2)).toBe(3);
    expect(zigzag32(2)).toBe(4);
    expect(zigzag32(2147483647)).toBe(4294967294);
    expect(zigzag32(-2147483648)).toBe(4294967295);
  });

  it('works on 64-bit values', () => {
    expect(zigzag64(0n)).toBe(0n);
    expect(zigzag64(-1n)).toBe(1n);
    expect(zigzag64(1n)).toBe(2n);
    expect(zigzag64(-2n)).toBe(3n);
  });
});

describe('CompactWriter — field headers', () => {
  it('uses the short form for a delta of 1..15', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.i32(1, 0); // (delta 1 << 4) | I32(5) = 0x15, then zigzag varint 0
    w.structEnd();
    expect(hex(w.bytes())).toBe('15 00 00');
  });

  it('advances the delta between consecutive fields', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.i32(1, 0); // 0x15 00
    w.i32(2, 0); // delta 1 again -> 0x15 00
    w.i32(5, 0); // delta 3 -> 0x35 00
    w.structEnd();
    expect(hex(w.bytes())).toBe('15 00 15 00 35 00 00');
  });

  it('falls back to the long form when the delta exceeds 15', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.i32(20, 0); // delta 20 > 15 -> type byte 0x05, zigzag varint(20)=40=0x28, value 0x00
    w.structEnd();
    expect(hex(w.bytes())).toBe('05 28 00 00');
  });
});

describe('CompactWriter — values', () => {
  it('encodes booleans inside the field header', () => {
    const t = new CompactWriter();
    t.structBegin();
    t.bool(1, true); // (1<<4)|BOOLEAN_TRUE(1) = 0x11, no value byte
    t.structEnd();
    expect(hex(t.bytes())).toBe('11 00');

    const f = new CompactWriter();
    f.structBegin();
    f.bool(1, false); // (1<<4)|BOOLEAN_FALSE(2) = 0x12
    f.structEnd();
    expect(hex(f.bytes())).toBe('12 00');
  });

  it('encodes i32/i64 as zigzag varints', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.i32(1, -1); // 0x15, zigzag(-1)=1
    w.i64(2, 300n); // 0x16, zigzag(300)=600 -> varint 0xd8 0x04
    w.structEnd();
    expect(hex(w.bytes())).toBe('15 01 16 d8 04 00');
  });

  it('encodes a string as varint length + UTF-8 bytes', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.string(1, 'ab'); // 0x18 (BINARY=8), len 2, 'a','b'
    w.structEnd();
    expect(hex(w.bytes())).toBe('18 02 61 62 00');
  });

  it('encodes a short list header inline', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.listBegin(1, CompactType.I32, 3); // 0x19 (LIST=9), (3<<4)|I32(5) = 0x35
    w.listI32(1);
    w.listI32(2);
    w.listI32(3);
    w.structEnd();
    expect(hex(w.bytes())).toBe('19 35 02 04 06 00');
  });

  it('uses the long list form for 15+ elements', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.listBegin(1, CompactType.I32, 20); // 0x19, (0xF<<4)|5 = 0xf5, varint(20)=0x14
    w.structEnd();
    expect(hex(w.bytes()).startsWith('19 f5 14')).toBe(true);
  });
});

describe('CompactWriter — nesting', () => {
  it('resets and restores field-id tracking across nested structs', () => {
    const w = new CompactWriter();
    w.structBegin();
    w.i32(1, 0); // 15 00
    w.fieldBegin(4, CompactType.STRUCT); // delta 3 -> 0x3c
    w.structBegin();
    w.i32(1, 0); // inner starts over: 15 00
    w.structEnd(); // 00
    w.i32(5, 0); // outer continues from 4 -> delta 1 -> 15 00
    w.structEnd();
    expect(hex(w.bytes())).toBe('15 00 3c 15 00 00 15 00 00');
  });
});
