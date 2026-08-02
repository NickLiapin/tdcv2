/**
 * The Dremel core: turning rows of lists into the three flat streams Parquet
 * actually stores.
 *
 * Parquet keeps no brackets. A list column is stored as the leaf values laid
 * end to end, plus two integer streams that let a reader rebuild the shape:
 *
 *   - **repetition level** — 0 starts a new ROW, 1 continues the current list;
 *   - **definition level** — how deep the value actually exists, which is how
 *     an empty list and a missing element are expressed without a value.
 *
 * Our schema is exactly one level of repetition:
 *
 *     required group <name> (LIST) {
 *         repeated group list {
 *             required|optional <physical> element
 *         }
 *     }
 *
 * so max rep is 1, and max def is 1 (required element) or 2 (optional). The
 * outer group is REQUIRED because we cannot produce "no list at all" — an empty
 * cell is an empty list — and declaring OPTIONAL would spend a level on a state
 * we never emit.
 *
 * Kept apart from the writer so it can be checked on its own against
 * hand-computed levels; getting these two streams wrong produces a file that
 * readers accept and then mis-assemble, which is the worst possible failure.
 * Spec: docs/specs/2026-07-19-repeated-values-lists-and-mix-ground-truth.md §5.
 */

/** One column's worth of rows, already split into elements. */
export type ListRows = readonly (readonly string[])[];

export interface ListLevels {
  /** Raw text of the elements that are present; NULL elements contribute none. */
  readonly present: string[];
  readonly repLevels: number[];
  readonly defLevels: number[];
  readonly maxDef: number;
  readonly maxRep: number;
}

/** Max definition level for a list whose element is (or is not) nullable. */
export function listMaxDef(elementNullable: boolean): number {
  return elementNullable ? 2 : 1;
}

/** Bits needed to hold levels up to `maxLevel`; 0 when there is nothing to say. */
export function levelBitWidth(maxLevel: number): number {
  let bits = 0;
  while (1 << bits <= maxLevel) bits++;
  return bits;
}

/**
 * Build the value/rep/def streams for one list column.
 *
 * An element is NULL when its text is empty AND the element type is nullable —
 * the same rule the scalar path uses, so `missing=` behaves identically whether
 * or not the column repeats. When the element is not nullable an empty string
 * is a legitimate empty value and is passed through to conversion, which will
 * reject it if the type cannot hold it.
 */
export function buildListLevels(rows: ListRows, elementNullable: boolean): ListLevels {
  const maxDef = listMaxDef(elementNullable);
  const present: string[] = [];
  const repLevels: number[] = [];
  const defLevels: number[] = [];

  for (const row of rows) {
    if (row.length === 0) {
      // An empty list still occupies one level slot; def 0 IS the statement
      // "this row has no elements". Without it the row would vanish.
      repLevels.push(0);
      defLevels.push(0);
      continue;
    }
    for (let k = 0; k < row.length; k++) {
      repLevels.push(k === 0 ? 0 : 1);
      const text = row[k] ?? '';
      if (elementNullable && text === '') {
        defLevels.push(maxDef - 1); // the slot exists, the value does not
        continue;
      }
      defLevels.push(maxDef);
      present.push(text);
    }
  }

  return { present, repLevels, defLevels, maxDef, maxRep: 1 };
}
