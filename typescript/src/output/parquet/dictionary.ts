/**
 * Dictionary encoding — store each distinct value once, then reference it.
 *
 * A column of city names repeats "Moscow" ten thousand times; PLAIN writes the
 * bytes ten thousand times, a dictionary writes them once and spends two BITS
 * per row pointing at them. This is the largest size win available to us short
 * of compression, and it costs no dependency.
 *
 * Whether to use it has to be decided from the DATA, and the decision must be
 * reproducible: a heuristic that consulted anything else — a clock, a memory
 * figure, a sampling rate — would put different bytes in the file on different
 * runs and break the cross-language contract the whole writer is built around.
 * So the rule below reads only the values.
 * Spec: docs/specs/2026-07-19-parquet-statistics-and-encodings.md §3
 */

import type { ColumnType } from '../column-type.js';

import type { TypedValue } from './convert.js';

/**
 * A dictionary pays for itself when values repeat. Requiring at least a 2×
 * reduction keeps it away from near-unique columns (ids, timestamps, uuids),
 * where the indices would be pure overhead on top of the values themselves.
 */
const MAX_DISTINCT_RATIO = 0.5;

/**
 * Beyond this, the dictionary page itself grows large enough that a reader
 * pays to load it even when it only wants a few rows.
 */
const MAX_DISTINCT = 1 << 16;

export interface Dictionary {
  /** The distinct values, in first-seen order — the dictionary page's contents. */
  readonly values: TypedValue[];
  /** One index per present value, pointing into `values`. */
  readonly indices: number[];
}

/** A stable key for value identity. Must not merge values a reader would tell apart. */
function keyOf(value: TypedValue): string {
  if (value instanceof Uint8Array) return `b:${Array.from(value).join(',')}`;
  if (typeof value === 'bigint') return `i:${value.toString()}`;
  // Numbers and strings are distinguished by prefix so 1 and "1" cannot merge.
  return `${typeof value}:${String(value)}`;
}

/**
 * Types worth dictionary-encoding. BOOLEAN is excluded because it already
 * costs one bit and a dictionary would only add a page; the fixed-width
 * numerics are included since repeated categories are common there too
 * (status codes, small enums stored as ints).
 */
function eligible(type: ColumnType): boolean {
  return type.kind !== 'bool';
}

/**
 * Build a dictionary for these values, or undefined when it would not pay.
 *
 * Returning undefined is the signal to keep PLAIN encoding — the caller must
 * not treat it as an error.
 */
export function buildDictionary(
  type: ColumnType,
  present: readonly TypedValue[],
): Dictionary | undefined {
  if (!eligible(type) || present.length === 0) return undefined;

  const seen = new Map<string, number>();
  const values: TypedValue[] = [];
  const indices: number[] = new Array<number>(present.length);

  for (let i = 0; i < present.length; i++) {
    const value = present[i] ?? null;
    const key = keyOf(value);
    let index = seen.get(key);
    if (index === undefined) {
      index = values.length;
      seen.set(key, index);
      values.push(value);
      // Stop as soon as it is clearly not worth it, rather than building a
      // dictionary the size of the column and then discarding it.
      if (values.length > MAX_DISTINCT) return undefined;
    }
    indices[i] = index;
  }

  if (values.length > present.length * MAX_DISTINCT_RATIO) return undefined;
  return { values, indices };
}
