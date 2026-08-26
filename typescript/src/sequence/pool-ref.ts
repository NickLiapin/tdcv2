/**
 * Resolving a `<gen type="pool">` reference into `Ref.field` columns.
 *
 * Split out of `build.ts` when that file reached its line ceiling, and the
 * split lands on a real seam: everything here is about handing a row a whole
 * MEMBER, while the file it left is about drawing a VALUE. It takes the pools
 * and the seed rather than the whole build options, which is what keeps the
 * import from pointing back.
 */

import { computeParentMask } from './assemble.js';
import { memberPicker } from './pool-member.js';
import { type PoolTables } from './pool.js';
import type { Sequence, SequenceSpec } from './types.js';

/**
 * Publish one member of a pool per row, under `Ref.field` for every field the
 * pool has.
 *
 * A reference registers no scalar column of its own: `${{Doctor}}` alone is not
 * a value, because a member is a record. The validator says that out loud
 * rather than letting it interpolate as the literal text — the silent failure a
 * compound sequence still has, and one worth not repeating here.
 */
export function registerPoolRef(
  spec: SequenceSpec,
  poolName: string,
  registry: Record<string, Sequence>,
  count: number,
  pools: PoolTables | undefined,
  seed: string,
  /**
   * The pick this reference makes when a config-level `<distinct>` has a say.
   * Absent for a reference in no group, which is every reference until one is
   * written — the plain pick then stands, bit for bit as before.
   */
  groupPick?: (i: number) => number,
): void {
  const table = pools?.[poolName];
  if (!table || table.count < 1) return; // unknown pool — the validator reports it
  const mask = computeParentMask(spec, registry, count);

  // One pick per ROW, shared by every field: this is what makes the first name
  // and the last name in a row belong to the same doctor. Not one pick per
  // field, which is exactly how "Дмитрий Иванова" would get out.
  const memberAt = groupPick ?? memberPicker(spec, poolName, table, registry, seed, count).pick;
  const members = new Array<number>(count);
  for (let i = 0; i < count; i++) members[i] = mask[i] ? memberAt(i) : -1;

  for (const field of table.fields) {
    const column = table.columns[field];
    if (!column) continue;
    const values = new Array<string | undefined>(count);
    for (let i = 0; i < count; i++) {
      const m = members[i] ?? -1;
      values[i] = m < 0 ? undefined : (column[m] ?? '');
    }
    registry[`${spec.name}.${field}`] = { name: `${spec.name}.${field}`, values };
  }
}

/**
 * The same reference, as LAZY columns for the streaming engines.
 *
 * A pool is small and is computed before the run starts, so it never threatens
 * the streaming engines' bounded memory: what streams is the two thousand
 * patients, not the thirty doctors. And because the member pick is seekable by
 * row, row 900 000 gets its doctor without the 899 999 before it existing — the
 * same member the in-memory engine would have handed it, from the same stream.
 *
 * `registry` is captured by reference and read at resolve time, which is how a
 * filter can compare against a column of the same row. The conditional
 * sequence beside it does exactly this.
 */
export function lazyPoolRefColumns(
  spec: SequenceSpec,
  poolName: string,
  registry: Record<string, Sequence>,
  pools: PoolTables | undefined,
  seed: string,
  /** See `registerPoolRef`: the group's say in this reference's pick, if any. */
  groupPick?: (i: number) => number,
): Record<string, Sequence> {
  const table = pools?.[poolName];
  if (!table || table.count < 1) return {};

  const memberAt = groupPick ?? memberPicker(spec, poolName, table, registry, seed).pick;

  const columns: Record<string, Sequence> = {};
  for (const field of table.fields) {
    const key = `${spec.name}.${field}`;
    columns[key] = {
      name: key,
      values: [],
      resolve: (i: number) => table.columns[field]?.[memberAt(i)] ?? '',
    };
  }
  return columns;
}
