/**
 * The declared type of an output column: `type="int64"`, `type="double|null"`,
 * `type="decimal(18,2)|null"` on a named `<data>`.
 *
 * Pure parsing of the attribute into a structured type. The mapping onto a
 * concrete container (Parquet physical + logical type) lives with that writer —
 * this layer is format-agnostic, so a future Arrow/Avro writer reuses it.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §2.
 */

export const COLUMN_KINDS = [
  'bool',
  'int32',
  'int64',
  // Unsigned integers: same physical storage, annotated so a reader knows the
  // top bit is magnitude rather than sign.
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float',
  'float16',
  'double',
  'string',
  'enum',
  'date',
  'timestamp',
  'decimal',
  'uuid',
  'json',
] as const;

export type ColumnKind = (typeof COLUMN_KINDS)[number];

export interface ColumnType {
  readonly kind: ColumnKind;
  /** `|null` — the column may hold NULL (Parquet OPTIONAL). */
  readonly nullable: boolean;
  /** decimal only: total digits. */
  readonly precision?: number;
  /** decimal only: digits after the point. */
  readonly scale?: number;
}

/**
 * A LIST column: `type="[]int64"`, or `type="[]int64|null"` where the `|null`
 * binds to the ELEMENT (read left to right: "a list of (int64 or nothing)").
 * That binding is what `missing=` on a repeating generator needs — it blanks
 * individual elements, never the list as a whole.
 *
 * There is no nullable LIST: an empty cell is an empty list, and we have no way
 * to express "no list at all", so we do not pretend to.
 */
export interface ListColumnType {
  readonly kind: 'list';
  readonly element: ColumnType;
}

/**
 * A MAP column: `type="{}int64"`, or `type="{}int64|null"` where the `|null`
 * binds to the VALUE — the same left-to-right reading a list has ("a map to
 * (int64 or nothing)").
 *
 * The KEY is always text. Parquet requires map keys to be non-null, and a cell
 * arrives here as text anyway, so a second type parameter would buy a
 * conversion nobody asked for and a syntax twice as wide.
 *
 * There is no nullable MAP, for the reason a list has none: an empty cell is an
 * empty map, and there is no way to say "no map at all".
 */
export interface MapColumnType {
  readonly kind: 'map';
  readonly value: ColumnType;
}

export type OutputColumnType = ColumnType | ListColumnType | MapColumnType;

export function isListType(type: OutputColumnType): type is ListColumnType {
  return type.kind === 'list';
}

export function isMapType(type: OutputColumnType): type is MapColumnType {
  return type.kind === 'map';
}

/** A list or a map — the shapes that hold several values in one cell. */
export function isRepeatedType(type: OutputColumnType): boolean {
  return isListType(type) || isMapType(type);
}

/**
 * Parse a `type="…"` that may be a list. Everything else defers to
 * `parseColumnType`, so scalar behaviour is untouched.
 */
export function parseOutputColumnType(raw: string): OutputColumnType {
  const text = raw.trim();
  if (text.startsWith('{}')) {
    const inner = text.slice(2).trim();
    if (inner === '') throw new Error('map type needs a value type, e.g. {}int64');
    if (inner.startsWith('[]') || inner.startsWith('{}')) {
      throw new Error(`a map value cannot itself be a list or a map, got "${text}"`);
    }
    return { kind: 'map', value: parseColumnType(inner) };
  }
  if (!text.startsWith('[]')) return parseColumnType(text);
  const inner = text.slice(2).trim();
  if (inner === '') throw new Error('list type needs an element type, e.g. []int64');
  if (inner.startsWith('[]')) {
    throw new Error(`nested lists are not supported, got "${text}"`);
  }
  if (inner.startsWith('{}')) {
    throw new Error(`a list of maps is not supported, got "${text}"`);
  }
  return { kind: 'list', element: parseColumnType(inner) };
}

/**
 * Largest decimal precision an int64 backing store holds (10^19 overflows a
 * signed 64-bit integer). Wider decimals need FIXED_LEN_BYTE_ARRAY — not in v1.
 */
const MAX_DECIMAL_PRECISION = 18;

function isColumnKind(value: string): value is ColumnKind {
  return (COLUMN_KINDS as readonly string[]).includes(value);
}

/** Parse a `type="…"` attribute. Throws with a user-facing message on bad input. */
export function parseColumnType(raw: string): ColumnType {
  const segments = raw.split('|');
  const head = (segments[0] ?? '').trim();
  if (head === '') throw new Error('column type must not be empty');

  let nullable = false;
  for (const segment of segments.slice(1)) {
    const modifier = segment.trim().toLowerCase();
    if (modifier === 'null') nullable = true;
    else {
      throw new Error(`unknown type modifier "${segment.trim()}" (only "null" is supported)`);
    }
  }

  const match = /^([a-z0-9_]+)\s*(?:\(([^)]*)\))?$/i.exec(head);
  const kind = (match?.[1] ?? '').toLowerCase();
  if (!match || !isColumnKind(kind)) throw new Error(`unknown column type "${head}"`);
  const params = match[2];

  if (kind !== 'decimal') {
    if (params !== undefined) {
      throw new Error(`only decimal takes parameters, got "${head}"`);
    }
    return { kind, nullable };
  }

  if (params === undefined) {
    throw new Error('decimal requires (precision,scale), e.g. decimal(18,2)');
  }
  const parts = params.split(',');
  if (parts.length !== 2) {
    throw new Error(`decimal requires (precision,scale), got "${head}"`);
  }
  const precision = Number((parts[0] ?? '').trim());
  const scale = Number((parts[1] ?? '').trim());
  if (!Number.isInteger(precision) || precision < 1 || precision > MAX_DECIMAL_PRECISION) {
    throw new Error(
      `decimal precision must be an integer 1..${String(MAX_DECIMAL_PRECISION)}, got "${parts[0]?.trim() ?? ''}"`,
    );
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new Error(
      `decimal scale must be an integer 0..precision (${String(precision)}), got "${parts[1]?.trim() ?? ''}"`,
    );
  }
  return { kind, nullable, precision, scale };
}
