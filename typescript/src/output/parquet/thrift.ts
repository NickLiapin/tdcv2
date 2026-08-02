/**
 * Thrift Compact Protocol writer.
 *
 * Parquet stores its page headers and its whole footer (`FileMetaData`) in this
 * encoding, so we need exactly the write side of it: unsigned LEB128 varints,
 * zigzag for signed integers, field headers carrying the delta to the previous
 * field id, and inline list headers. Small and fully specified — but a single
 * wrong byte makes the file unreadable, so it lives in its own module with
 * byte-exact tests.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §6.
 */

/** Thrift Compact type ids (booleans carry their value in the field header). */
export const CompactType = {
  BOOLEAN_TRUE: 1,
  BOOLEAN_FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  SET: 10,
  MAP: 11,
  STRUCT: 12,
} as const;

export type CompactType = (typeof CompactType)[keyof typeof CompactType];

/** Unsigned LEB128: 7 bits per byte, high bit marks "more bytes follow". */
export function encodeVarint(value: number | bigint): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) throw new Error('varint must be non-negative');
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Uint8Array.from(out);
}

/** Map a signed 32-bit value onto an unsigned one so small magnitudes stay short. */
export function zigzag32(value: number): number {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

/** 64-bit zigzag. */
export function zigzag64(value: bigint): bigint {
  return (value << 1n) ^ (value >> 63n);
}

export class CompactWriter {
  private readonly out: number[] = [];
  /** Field ids are written as a delta from the previous field of this struct. */
  private lastFieldId = 0;
  private readonly stack: number[] = [];

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }

  /** Current byte length — used to fill in page/footer offsets. */
  get length(): number {
    return this.out.length;
  }

  private raw(byte: number): void {
    this.out.push(byte & 0xff);
  }

  private rawBytes(bytes: Uint8Array): void {
    for (const b of bytes) this.out.push(b);
  }

  structBegin(): void {
    this.stack.push(this.lastFieldId);
    this.lastFieldId = 0;
  }

  structEnd(): void {
    this.raw(0x00); // struct stop
    this.lastFieldId = this.stack.pop() ?? 0;
  }

  /** Write a field header. Short form when the id delta is 1..15, else long form. */
  fieldBegin(id: number, type: CompactType): void {
    const delta = id - this.lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.raw((delta << 4) | type);
    } else {
      this.raw(type);
      this.rawBytes(encodeVarint(zigzag32(id)));
    }
    this.lastFieldId = id;
  }

  /** Booleans have no value bytes — true/false is the field header's type. */
  bool(id: number, value: boolean): void {
    this.fieldBegin(id, value ? CompactType.BOOLEAN_TRUE : CompactType.BOOLEAN_FALSE);
  }

  /**
   * Thrift `i8` — a single raw byte, NOT zigzag-encoded like i16/i32/i64.
   * `LogicalType.IntType.bitWidth` is declared i8, so writing it as an i32
   * would shift every field after it.
   */
  i8(id: number, value: number): void {
    this.fieldBegin(id, CompactType.BYTE);
    this.out.push(value & 0xff);
  }

  i32(id: number, value: number): void {
    this.fieldBegin(id, CompactType.I32);
    this.rawBytes(encodeVarint(zigzag32(value)));
  }

  i64(id: number, value: number | bigint): void {
    this.fieldBegin(id, CompactType.I64);
    this.rawBytes(encodeVarint(zigzag64(typeof value === 'bigint' ? value : BigInt(value))));
  }

  binary(id: number, value: Uint8Array): void {
    this.fieldBegin(id, CompactType.BINARY);
    this.rawBytes(encodeVarint(value.length));
    this.rawBytes(value);
  }

  string(id: number, value: string): void {
    this.binary(id, new TextEncoder().encode(value));
  }

  /**
   * Open a list field. Elements follow with the `list*` writers (no field
   * headers inside a list); a list of structs uses `structBegin`/`structEnd`.
   */
  listBegin(id: number, elementType: CompactType, size: number): void {
    this.fieldBegin(id, CompactType.LIST);
    if (size < 15) {
      this.raw((size << 4) | elementType);
    } else {
      this.raw((0x0f << 4) | elementType);
      this.rawBytes(encodeVarint(size));
    }
  }

  listI32(value: number): void {
    this.rawBytes(encodeVarint(zigzag32(value)));
  }

  listI64(value: number | bigint): void {
    this.rawBytes(encodeVarint(zigzag64(typeof value === 'bigint' ? value : BigInt(value))));
  }

  listString(value: string): void {
    const bytes = new TextEncoder().encode(value);
    this.rawBytes(encodeVarint(bytes.length));
    this.rawBytes(bytes);
  }
}
