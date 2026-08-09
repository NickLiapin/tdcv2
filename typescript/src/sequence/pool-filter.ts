/**
 * `filter=` — which members of a pool a row is allowed to draw from.
 *
 * The distinction that decides everything here, and the one to keep in the
 * documentation, is between this and `if=`:
 *
 *   `if=` false   → nothing is generated, the cell is empty.
 *   `filter=`     → a matching record is substituted; an empty cell never
 *                   happens, and "nobody matched" is an error rather than a gap.
 *
 * They also ask about different things. `if=` asks about the ROW — one answer
 * per row. `filter=` asks about each CANDIDATE — thirty answers per row for a
 * pool of thirty. That is why they are two attributes and can appear together:
 *
 *   <gen type="pool" value="Doctors" if="Age >= 18" filter="clinic == Clinic"/>
 *
 * The expression is the ordinary one, evaluated in two scopes: a bare name is a
 * field of the candidate, anything else is a column of the current row. So
 * `price <= Budget` reads as "a product this customer can afford", which is
 * worth more than the clinic example that prompted the feature.
 *
 * One shape gets a fast path. `field == Column` (either way round) is the
 * common case and can be answered by bucketing the pool once, so a row costs a
 * map lookup instead of a scan over every member. Anything richer is a scan —
 * correct, and linear in the pool size, which is why the pool has a ceiling.
 */

import { evaluateInScope } from '../expr/evaluate.js';
import { matchKey } from '../expr/match-key.js';
import type { PoolTable } from './pool.js';

/** `field == Column` — the shape worth bucketing for. */
export interface EqualityFilter {
  /** Field of the pool member. */
  readonly field: string;
  /** Column of the row it must equal. */
  readonly column: string;
}

/**
 * Recognise `field == Column` / `Column == field`, and nothing else.
 *
 * Deliberately a string match rather than an AST inspection: the fast path must
 * be obvious to a reader of the config, not a surprise that appears when an
 * expression happens to normalise into the right shape. If it does not look
 * like the simple case, it is not treated as one.
 */
export function parseEqualityFilter(
  expr: string,
  table: PoolTable,
  isColumn: (name: string) => boolean,
): EqualityFilter | undefined {
  const parts = expr.split('==');
  if (parts.length !== 2) return undefined;
  const left = (parts[0] ?? '').trim();
  const right = (parts[1] ?? '').trim();
  // A dotted name is a name too. `Doctors.clinic` is the qualified spelling
  // TDC232 tells the author to reach for when a name is both a field and a
  // column — and it used to fall off the fast path here and scan every member,
  // measured at 24.88 s against 1.18 s for the bare spelling of the same
  // filter. Taking the advice must not cost twenty times the run.
  if (!isName(left) || !isName(right)) return undefined;
  // BOTH sides must be what they look like. Without the `isColumn` test,
  // `filter="clinic == North"` — where North is a bare word, which the
  // expression language has always allowed and which is the obvious way to
  // write "northern doctors only" — was read as a comparison against a column
  // named North, found nothing, and refused the run. The general path handles
  // it correctly, so the fast path simply declines.
  const asField = (name: string): string | undefined => {
    const prefix = `${table.name}.`;
    const bare = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    return table.fields.includes(bare) ? bare : undefined;
  };
  const leftField = asField(left);
  if (leftField !== undefined && isColumn(right)) return { field: leftField, column: right };
  const rightField = asField(right);
  if (rightField !== undefined && isColumn(left)) return { field: rightField, column: left };
  return undefined;
}

/** A bare name, or one qualified with a dot — `clinic`, `Doctors.clinic`. */
function isName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s);
}

/**
 * member value → the members holding it. Built once per reference.
 *
 * Keyed by `matchKey` rather than by the raw text, so the bucket answers the
 * same question `==` would: a member holding `"01"` is found by a row producing
 * `"1"`, exactly as the general expression path finds it.
 */
export function bucketByField(table: PoolTable, field: string): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  const column = table.columns[field] ?? [];
  for (let m = 0; m < table.count; m++) {
    const key = matchKey(column[m] ?? '');
    const bucket = buckets.get(key);
    if (bucket) bucket.push(m);
    else buckets.set(key, [m]);
  }
  return buckets;
}

/**
 * The members of `table` for which `expr` holds on this row.
 *
 * `rowValue` reads a column of the current row; a name it does not know is left
 * for the evaluator to treat as a bare word, exactly as `if=` does.
 */
export function eligibleMembers(
  expr: string,
  table: PoolTable,
  rowValue: (name: string) => string | undefined,
  /**
   * Filled with the ROW columns the expression actually read, and what they held.
   *
   * The refusal for "nobody matched" used to name them only on the bucketed
   * `field == Column` path, so the general one told the author which filter
   * failed and never what the row was looking for — the one fact that says
   * whether the pool is missing a member or the filter is wrong. Recorded here
   * rather than parsed out of the expression: what the evaluator asked for IS
   * what the filter reads, including through `&&` and a ternary.
   */
  readRowValues?: Map<string, string>,
): number[] {
  const prefix = `${table.name}.`;
  const eligible: number[] = [];
  for (let m = 0; m < table.count; m++) {
    const ok = evaluateInScope(expr, (name) => {
      // Qualified first — `Doctors.clinic` always means the member's field, and
      // it is the escape hatch TDC232 tells the author to reach for when a name
      // is both a field and a column. It has to work, or the hint is a lie.
      if (name.startsWith(prefix)) {
        const qualified = table.columns[name.slice(prefix.length)];
        if (qualified) return qualified[m] ?? '';
      }
      const column = table.columns[name];
      // Then the candidate's own field. A name that is BOTH a field and a row
      // column is refused by the validator rather than silently resolved one
      // way here, so this branch never has to guess.
      if (column) return column[m] ?? '';
      const value = rowValue(name);
      if (readRowValues && value !== undefined) readRowValues.set(name, value);
      return value;
    });
    if (ok) eligible.push(m);
  }
  return eligible;
}

/** ` (Clinic="North", Budget="40")` — what the row held, for the refusal below. */
export function rowValuesDetail(values: ReadonlyMap<string, string>): string {
  if (values.size === 0) return '';
  const parts = [...values].map(([name, value]) => `${name}="${value}"`);
  return ` (${parts.join(', ')})`;
}

/** The refusal a row gets when the filter leaves it with no member at all. */
export function noCandidateMessage(
  poolName: string,
  expr: string,
  row: number,
  detail: string,
): string {
  return (
    `pool "${poolName}": no member satisfies filter="${expr}" for row ${String(row + 1)}${detail}. ` +
    'A filter narrows the members a row may draw from; when it narrows them to none there is ' +
    'nothing to substitute. Add a member that matches, or widen the filter.'
  );
}
