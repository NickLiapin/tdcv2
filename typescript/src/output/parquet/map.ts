/**
 * `MAP` columns: `type="{}int64"` over a cell that reads `alpha:1,beta:2`.
 *
 * Parquet stores a map as a repeated group of key/value pairs, so the shape is
 * the LIST shape with two leaves instead of one:
 *
 *     required group <name> (MAP) {
 *         repeated group key_value {
 *             required BYTE_ARRAY key (STRING);
 *             required|optional <physical> value;
 *         }
 *     }
 *
 * Max rep is 1 for both leaves. Max def is 1 for the key — it is REQUIRED, as
 * the format insists, because a pair with no key is not a pair — and 1 or 2 for
 * the value depending on whether it is nullable.
 *
 * ── Why the key is always text ───────────────────────────────────────────────
 * A cell arrives here as text, and Parquet forbids a null key. A second type
 * parameter would double the syntax to buy a conversion nobody has asked for,
 * so `{}T` reads "a map from text to T" and there is nothing else to decide.
 *
 * Kept apart from the writer so the level streams can be checked against
 * hand-computed ones. Getting them wrong produces a file readers accept and
 * then mis-assemble, which is the worst failure this writer has.
 */

/** One row's pairs, in the order written. */
export interface MapEntry {
  readonly key: string;
  /** The value's raw text; `undefined` is a NULL value (nullable maps only). */
  readonly value: string | undefined;
}

export type MapRows = readonly (readonly MapEntry[])[];

export interface MapLevels {
  /** Every key, in order — the key leaf's values. Keys are never NULL. */
  readonly keys: string[];
  /** The values that are present; NULL values contribute none. */
  readonly present: string[];
  readonly repLevels: number[];
  /** The key leaf's definition levels; max 1. */
  readonly keyDefLevels: number[];
  /** The value leaf's definition levels; max 1 or 2. */
  readonly valueDefLevels: number[];
  readonly maxValueDef: number;
}

/** Max definition level for a map value that is (or is not) nullable. */
export function mapValueMaxDef(valueNullable: boolean): number {
  return valueNullable ? 2 : 1;
}

/** The key leaf's max definition level. Always 1: the key is REQUIRED inside a pair. */
export const MAP_KEY_MAX_DEF = 1;

/**
 * Split one cell into pairs — `alpha:1,beta:2` on the column's separator.
 *
 * The key is everything before the FIRST `:`, the value everything after, so a
 * value may hold colons (a timestamp does) and a key may not. That asymmetry is
 * the one worth having: keys are short labels, values are whatever the column
 * generates.
 *
 * Three things are refused rather than guessed at, and each would otherwise
 * produce a map that is quietly missing an entry:
 *
 *   - a piece with no `:` at all — is it a key with no value, or the reverse?
 *   - an empty key, which Parquet has no way to store;
 *   - a key that repeats inside one row, because readers disagree about which
 *     of the two wins and some drop the row's map entirely.
 */
export function parseMapCell(text: string, separator: string, valueNullable: boolean): MapEntry[] {
  // An empty cell is an EMPTY MAP, not a map holding one blank pair — the same
  // rule a list follows, for the same reason.
  if (text === '') return [];

  const entries: MapEntry[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(separator)) {
    const at = piece.indexOf(':');
    if (at < 0) {
      throw new Error(
        `map entry "${piece}" has no ":" — a map cell reads key:value${separator}key:value`,
      );
    }
    const key = piece.slice(0, at);
    if (key === '') throw new Error(`map entry "${piece}" has an empty key`);
    if (seen.has(key)) throw new Error(`map key "${key}" appears twice in one cell`);
    seen.add(key);
    const value = piece.slice(at + 1);
    entries.push({ key, value: valueNullable && value === '' ? undefined : value });
  }
  return entries;
}

/**
 * Build the key/value/rep/def streams for one map column.
 *
 * An empty map still occupies one level slot in BOTH leaves: def 0 is the
 * statement "this row has no pairs". Without it the row would vanish from the
 * column, and every row after it would shift up by one.
 */
export function buildMapLevels(rows: MapRows, valueNullable: boolean): MapLevels {
  const maxValueDef = mapValueMaxDef(valueNullable);
  const keys: string[] = [];
  const present: string[] = [];
  const repLevels: number[] = [];
  const keyDefLevels: number[] = [];
  const valueDefLevels: number[] = [];

  for (const row of rows) {
    if (row.length === 0) {
      repLevels.push(0);
      keyDefLevels.push(0);
      valueDefLevels.push(0);
      continue;
    }
    for (let k = 0; k < row.length; k++) {
      const entry = row[k];
      if (entry === undefined) continue;
      repLevels.push(k === 0 ? 0 : 1);
      keyDefLevels.push(MAP_KEY_MAX_DEF);
      keys.push(entry.key);
      if (entry.value === undefined) {
        valueDefLevels.push(maxValueDef - 1); // the pair exists, the value does not
        continue;
      }
      valueDefLevels.push(maxValueDef);
      present.push(entry.value);
    }
  }

  return { keys, present, repLevels, keyDefLevels, valueDefLevels, maxValueDef };
}
