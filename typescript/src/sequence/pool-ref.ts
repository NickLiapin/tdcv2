/**
 * Resolving a `<gen type="pool">` reference into `Ref.field` columns.
 *
 * Split out of `build.ts` when that file reached its line ceiling, and the
 * split lands on a real seam: everything here is about handing a row a whole
 * MEMBER, while the file it left is about drawing a VALUE. It takes the pools
 * and the seed rather than the whole build options, which is what keeps the
 * import from pointing back.
 */

import { matchKey } from '../expr/match-key.js';
import { seekableInt } from '../prng/seekable.js';
import { computeParentMask } from './assemble.js';
import {
  bucketByField,
  eligibleMembers,
  noCandidateMessage,
  parseEqualityFilter,
} from './pool-filter.js';
import { pickMember, poolRefStream, type PoolTable, type PoolTables } from './pool.js';
import { sequenceValueAt } from './types.js';
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
): void {
  const table = pools?.[poolName];
  if (!table || table.count < 1) return; // unknown pool — the validator reports it
  const mask = computeParentMask(spec, registry, count);

  // One pick per ROW, shared by every field: this is what makes the first name
  // and the last name in a row belong to the same doctor. Not one pick per
  // field, which is exactly how "Дмитрий Иванова" would get out.
  const filter = (spec.gen?.attrs['filter'] ?? '').trim();
  const members = new Array<number>(count);
  if (filter === '') {
    for (let i = 0; i < count; i++) {
      members[i] = mask[i] ? pickMember(seed, spec.name, table, i) : -1;
    }
  } else {
    pickFilteredMembers(spec, poolName, filter, table, registry, count, mask, seed, members);
  }

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
 * Pick a member per row when the reference carries a `filter=`.
 *
 * The draw stays uniform over the members that PASS — not "the first match",
 * which would hand every eligible row the same doctor and quietly destroy the
 * spread the pool was built to have.
 */
function pickFilteredMembers(
  spec: SequenceSpec,
  poolName: string,
  filter: string,
  table: PoolTable,
  registry: Record<string, Sequence>,
  count: number,
  mask: readonly boolean[],
  seed: string,
  members: number[],
): void {
  const rowValue = (i: number) => (name: string) => {
    const seq = registry[name];
    return seq ? (sequenceValueAt(seq, i) ?? '') : undefined;
  };

  // `field == Column` is bucketed once; a row then costs a map lookup instead
  // of a walk over every member. Everything else is a scan per row, which is
  // honest and linear — and the reason a pool has a size ceiling at all.
  const equality = parseEqualityFilter(filter, table, (n) => registry[n] !== undefined);
  const buckets = equality ? bucketByField(table, equality.field) : undefined;

  for (let i = 0; i < count; i++) {
    if (!mask[i]) {
      members[i] = -1;
      continue;
    }
    let eligible: readonly number[];
    let detail = '';
    if (equality && buckets) {
      const driver = registry[equality.column];
      const wanted = driver ? (sequenceValueAt(driver, i) ?? '') : '';
      eligible = buckets.get(matchKey(wanted)) ?? [];
      detail = ` (${equality.column}="${wanted}")`;
    } else {
      eligible = eligibleMembers(filter, table, rowValue(i));
    }
    if (eligible.length === 0) {
      throw new Error(noCandidateMessage(poolName, filter, i, detail));
    }
    // Same stream as an unfiltered reference, so adding a filter changes WHICH
    // members are on offer without disturbing anything else in the run.
    const slot = seekableInt(seed, poolRefStream(spec.name), i, eligible.length);
    members[i] = eligible[slot] ?? -1;
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
): Record<string, Sequence> {
  const table = pools?.[poolName];
  if (!table || table.count < 1) return {};

  const filter = (spec.gen?.attrs['filter'] ?? '').trim();
  const equality =
    filter === ''
      ? undefined
      : parseEqualityFilter(filter, table, (n) => registry[n] !== undefined);
  const buckets = equality ? bucketByField(table, equality.field) : undefined;

  const memberAt = (i: number): number => {
    if (filter === '') return pickMember(seed, spec.name, table, i);
    let eligible: readonly number[];
    let detail = '';
    if (equality && buckets) {
      const driver = registry[equality.column];
      const wanted = driver ? (sequenceValueAt(driver, i) ?? '') : '';
      eligible = buckets.get(matchKey(wanted)) ?? [];
      detail = ` (${equality.column}="${wanted}")`;
    } else {
      eligible = eligibleMembers(filter, table, (name) => {
        const seq = registry[name];
        return seq ? (sequenceValueAt(seq, i) ?? '') : undefined;
      });
    }
    if (eligible.length === 0) {
      throw new Error(noCandidateMessage(poolName, filter, i, detail));
    }
    return eligible[seekableInt(seed, poolRefStream(spec.name), i, eligible.length)] ?? 0;
  };

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
