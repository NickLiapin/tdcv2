/**
 * Column statistics — the min, the max and the NULL count of a column chunk.
 *
 * This is what lets a reader SKIP a whole row group: asked for `price > 500`,
 * it consults the chunk's max and moves on without decoding a byte. Cheap for
 * us (we already hold every value) and a large win for whoever queries the
 * file.
 *
 * The danger is the reverse of most features: WRONG statistics are worse than
 * none at all. A max that is too low makes a reader skip a group that really
 * did contain matching rows, and the query silently returns fewer results — no
 * error, no warning. So the comparisons here follow Parquet's declared sort
 * orders exactly rather than JavaScript's defaults:
 *
 *   - BYTE_ARRAY (strings) compare as UNSIGNED BYTES of their UTF-8 encoding.
 *     JavaScript's `<` compares UTF-16 code units, which agrees only for
 *     ASCII — "я" vs "ё" would come out wrong, and this project generates
 *     Russian data.
 *   - DOUBLE skips NaN entirely: NaN compares false against everything, so
 *     letting one in would poison the bound.
 *   - Everything else is numeric on its stored representation, which for
 *     DECIMAL means the unscaled integer and for DATE the day number.
 *
 * We write `min_value`/`max_value` (fields 5/6) and not the deprecated
 * `min`/`max` (1/2): the old pair had ambiguous signedness that readers
 * disagreed about, and writing a field readers may misread is the same trap as
 * writing a wrong bound.
 * Spec: docs/specs/2026-07-19-parquet-statistics-and-encodings.md
 */

import type { ColumnType } from '../column-type.js';

import type { TypedValue } from './convert.js';
import { halfBits } from './plain.js';

export interface ColumnStatistics {
  /** PLAIN-encoded single value; absent when the chunk has no non-NULL value. */
  readonly minValue?: Uint8Array;
  readonly maxValue?: Uint8Array;
  readonly nullCount: number;
}

const utf8 = new TextEncoder();

/** Unsigned byte-wise comparison — Parquet's sort order for BYTE_ARRAY. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** PLAIN encoding of ONE value, as statistics store it (no length prefix). */
function encodeOne(type: ColumnType, value: TypedValue): Uint8Array {
  switch (type.kind) {
    case 'bool': {
      return Uint8Array.from([value === true ? 1 : 0]);
    }
    case 'int32':
    case 'date':
    case 'uint8':
    case 'uint16':
    case 'uint32': {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, Number(value), true);
      return out;
    }
    case 'float': {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setFloat32(0, Number(value), true);
      return out;
    }
    case 'float16': {
      const out = new Uint8Array(2);
      new DataView(out.buffer).setUint16(0, halfBits(Number(value)), true);
      return out;
    }
    case 'int64':
    case 'timestamp':
    case 'decimal':
    case 'uint64': {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setBigInt64(0, value as bigint, true);
      return out;
    }
    case 'double': {
      const out = new Uint8Array(8);
      new DataView(out.buffer).setFloat64(0, Number(value), true);
      return out;
    }
    case 'string':
    case 'enum':
    case 'json': {
      return utf8.encode(String(value));
    }
    case 'uuid': {
      return value instanceof Uint8Array ? value : new Uint8Array(0);
    }
  }
}

/**
 * Order two present values of this column type. Returns undefined when the
 * type has no usable order for a value (only NaN, today), so the caller can
 * leave it out of the bounds entirely.
 */
function compareValues(type: ColumnType, a: TypedValue, b: TypedValue): number | undefined {
  switch (type.kind) {
    case 'bool':
      return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    case 'int32':
    case 'date':
    case 'float':
    case 'float16':
    case 'double': {
      const x = Number(a);
      const y = Number(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'uint8':
    case 'uint16':
      // Small unsigned kinds keep their true value in the INT32 slot.
      return Number(a) - Number(b);
    case 'uint32':
    case 'uint64': {
      // Stored as wrapped signed bits, so they must be compared UNSIGNED —
      // otherwise 2^63 would look smaller than 1 and the bound would be wrong.
      const width = type.kind === 'uint32' ? 32n : 64n;
      const x = BigInt.asUintN(Number(width), BigInt(a as number | bigint));
      const y = BigInt.asUintN(Number(width), BigInt(b as number | bigint));
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'int64':
    case 'timestamp':
    case 'decimal': {
      const x = a as bigint;
      const y = b as bigint;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'string':
    case 'enum':
    case 'json':
      return compareBytes(utf8.encode(String(a)), utf8.encode(String(b)));
    case 'uuid':
      return compareBytes(a as Uint8Array, b as Uint8Array);
  }
}

/** True when a value cannot take part in a bound (NaN only, for now). */
function unusable(type: ColumnType, value: TypedValue): boolean {
  const floaty = type.kind === 'double' || type.kind === 'float' || type.kind === 'float16';
  return floaty && Number.isNaN(Number(value));
}

/**
 * Min, max and NULL count for one column chunk.
 *
 * `present` holds the non-NULL values in row order; `nullCount` is supplied by
 * the caller because for a list column the NULLs live in the definition levels
 * rather than in the value array.
 */
export function computeStatistics(
  type: ColumnType,
  present: readonly TypedValue[],
  nullCount: number,
): ColumnStatistics {
  let min: TypedValue | undefined;
  let max: TypedValue | undefined;

  for (const value of present) {
    if (value === null || unusable(type, value)) continue;
    if (min === undefined || (compareValues(type, value, min) ?? 0) < 0) min = value;
    if (max === undefined || (compareValues(type, value, max) ?? 0) > 0) max = value;
  }

  if (min === undefined || max === undefined) return { nullCount };
  return {
    minValue: encodeOne(type, min),
    maxValue: encodeOne(type, max),
    nullCount,
  };
}
