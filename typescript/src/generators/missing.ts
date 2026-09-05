/**
 * Missing-data injection — `missing="p"` on any `<gen>`, with the three
 * mechanisms the literature names.
 *
 * Each value is independently blanked with probability `p`, drawing once per row
 * from the same PRNG the generator uses — so it is deterministic and seekable,
 * and works in both the in-memory and streaming engines. The blank is an empty
 * string by default, or the `missing_as="..."` token (e.g. `NULL`, `NA`).
 *
 * `missing_when="…"` decides WHICH rows are eligible, and that one attribute is
 * the whole difference between the three:
 *
 *   MCAR  missing="0.2"                          every row eligible
 *   MAR   missing="0.4" missing_when="Age < 30"  eligibility from ANOTHER column
 *   MNAR  missing="0.5" missing_when="_value > 150000"   from the value itself
 *
 * The names are worth keeping straight because they are not decoration: a
 * detector trained on MCAR has nothing to learn — the holes carry no signal —
 * while MAR holes are predictable from what you can still see, and MNAR holes
 * are predictable only from what was taken away. Which one a fixture uses
 * decides what a model can be scored on.
 *
 * The condition is the same expression language `if=` speaks, evaluated against
 * the same per-row column reader, so nothing about seekability changes: a
 * streaming engine replays row `i` without holding the column.
 */

import { evaluateInScope } from '../expr/evaluate.js';

/**
 * The value this row would have held, inside `missing_when`.
 *
 * Named like the run's other built-ins (`_count`, `_first`, `_last`, `_total`)
 * because it is one: a name the language provides rather than one a config
 * declares. The underscore is what keeps it from colliding with a column.
 */
export const MISSING_VALUE_NAME = '_value';

export interface MissingSpec {
  /** Probability in [0, 1] that an ELIGIBLE value is blanked. */
  readonly p: number;
  /** Replacement for a blanked value (default empty string). */
  readonly token: string;
  /**
   * Which rows are eligible at all. Absent means every row — MCAR.
   *
   * Kept as the source text rather than a parsed tree because the evaluator
   * takes text, and because the streaming engine builds this spec per row: a
   * tree parsed here would be parsed a million times instead of cached where
   * the expression layer already caches it.
   */
  readonly when?: string | undefined;
}

/** Parse `missing` / `missing_as`; `undefined` when no `missing` is set. Throws on a bad probability. */
export function parseMissing(attrs: Record<string, string | undefined>): MissingSpec | undefined {
  const raw = attrs['missing'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const p = Number(raw);
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`missing: probability "${raw}" must be a number in [0, 1]`);
  }
  const when = attrs['missing_when']?.trim();
  return { p, token: attrs['missing_as'] ?? '', when: when === '' ? undefined : when };
}

/**
 * Blank each value with probability `spec.p`, one draw per row. Mutates and
 * returns `values`. `draw` is asked for the uniform of row i — see
 * `applyAnomaly` for why the row, not the next one, is what it takes.
 */
export function applyMissing(
  values: string[],
  spec: MissingSpec,
  draw: (i: number) => number,
  /**
   * Is row `i` eligible? Absent means every row is — MCAR.
   *
   * The draw is made ONLY for an eligible row, and that is deliberate. Drawing
   * for every row and discarding the result would keep the stream aligned no
   * matter what the condition said, which sounds tidier and is worse: it spends
   * a number per row on a column that may never blank, and it makes the
   * eligible rows' randomness depend on how many ineligible ones came before —
   * so widening a condition would change the values of rows it does not cover.
   * `drawOn` is seekable per row, so skipping costs nothing and keeps each row's
   * decision its own.
   */
  eligible?: (i: number, value: string) => boolean,
): string[] {
  if (spec.p <= 0) return values; // no draws when nothing can go missing
  for (let i = 0; i < values.length; i++) {
    if (eligible && !eligible(i, values[i] ?? '')) continue;
    if (draw(i) < spec.p) values[i] = spec.token;
  }
  return values;
}

/**
 * The `missing_when` test for one row, or `undefined` when there is no condition.
 *
 * Built here rather than at each call site because four of them ask the same
 * question — the in-memory column pass, the streaming value pass, the streaming
 * `anomaly_flag`, and the ports' equivalents — and a condition answered one way
 * in one engine and another way in the next is exactly the silent wrong file
 * this project exists to prevent.
 *
 * `has` and `valueAt` are the caller's column reader: the in-memory engine's
 * columns, the streaming engine's lazy registry. `has` is separate from the
 * value because an ABSENT name is not an empty one — an unresolved bare word
 * evaluates to the WORD, the way `if="Tier == hi"` reads `hi`.
 */
export function missingEligibility(
  when: string | undefined,
  has: (name: string) => boolean,
  valueAt: (name: string, row: number) => string,
): ((row: number, value: string) => boolean) | undefined {
  if (when === undefined) return undefined;
  return (row, value) =>
    evaluateInScope(when, (name) =>
      name === MISSING_VALUE_NAME ? value : has(name) ? valueAt(name, row) : undefined,
    );
}
