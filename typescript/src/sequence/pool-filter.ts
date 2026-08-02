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
  if (!isPlainName(left) || !isPlainName(right)) return undefined;
  // BOTH sides must be what they look like. Without the `isColumn` test,
  // `filter="clinic == North"` — where North is a bare word, which the
  // expression language has always allowed and which is the obvious way to
  // write "northern doctors only" — was read as a comparison against a column
  // named North, found nothing, and refused the run. The general path handles
  // it correctly, so the fast path simply declines.
  if (table.fields.includes(left) && isColumn(right)) return { field: left, column: right };
  if (table.fields.includes(right) && isColumn(left)) return { field: right, column: left };
  return undefined;
}

function isPlainName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/** member value → the members holding it. Built once per reference. */
export function bucketByField(table: PoolTable, field: string): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  const column = table.columns[field] ?? [];
  for (let m = 0; m < table.count; m++) {
    const key = column[m] ?? '';
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
      return rowValue(name);
    });
    if (ok) eligible.push(m);
  }
  return eligible;
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
