/**
 * Computing a `<pool>` — once, before any row exists.
 *
 * Separate from `pool.ts` only to keep the imports acyclic: `build.ts` needs
 * the pool TYPE and the member pick, while computing a pool needs `build.ts`
 * itself. The split costs one file and buys a dependency graph that stays a
 * graph.
 *
 * Every pool draws from a DERIVED seed, `<seed>#pool:<Name>`. This is the one
 * decision here worth arguing for. The alternative — taking the pool's values
 * off the main stream — would mean that adding a pool to a config silently
 * shifts every column declared after it: the ids stay, but the ages, the names
 * and the dates all move, and a snapshot recorded last week stops matching for
 * a reason nobody can see in the diff. With a derived seed a pool is invisible
 * to everything it does not feed.
 */

import { buildSequences, type SequenceBuildOptions } from './build.js';
import { createPrng } from '../prng/prng.js';
import type { PoolSpec, PoolTable, PoolTables } from './pool.js';

/** The seed a pool's own values are drawn from. Part of the cross-language contract. */
export function poolSeed(seed: string, poolName: string): string {
  return `${seed}#pool:${poolName}`;
}

/**
 * Compute every pool declared in the config.
 *
 * A pool is built by the ordinary sequence machinery with `count` set to the
 * member count instead of the row count — which is the whole reason a `<uniq>`,
 * a `<mix>`, an `if=` or a `parent=` inside a pool behaves exactly as it does
 * outside one, with no code here to make it so.
 */
export function buildPoolTables(
  pools: readonly PoolSpec[],
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
): PoolTables {
  const tables: Record<string, PoolTable> = {};
  for (const pool of pools) {
    if (pool.name === '' || pool.count < 1) continue; // the validator already said so
    const prng = createPrng(poolSeed(seed, pool.name));
    const registry = buildSequences(pool.specs, pool.count, prng, locale, now, {
      ...options,
      // The pools already built — so a MEMBER can reference one, the same way a
      // row does. Declaration order is the whole cycle check: a pool can only
      // see the pools above it, so `Doctors` reaching `Clinics` is a table
      // lookup and `Clinics` reaching `Doctors` is a name that does not exist.
      pools: tables,
      // Its own derived seed, so the member a doctor works at is fixed by the
      // pool rather than by wherever the run happens to have got to.
      seed: poolSeed(seed, pool.name),
      envDistinctGroups: pool.distinctGroups,
      envUniqGroups: pool.uniqGroups,
    });

    const fields: string[] = [];
    const columns: Record<string, readonly string[]> = {};
    for (const spec of pool.specs) {
      const column = registry[spec.name];
      if (column) {
        fields.push(spec.name);
        columns[spec.name] = column.values.map((v) => v ?? '');
      }
      // A compound member column also publishes `Name.Field`; a pool exposes
      // those under the same dotted name, so `${{Doctor.address.city}}` reads
      // the way the config wrote it. A member that references another pool has
      // ONLY these — a record has no scalar value — which is why the loop above
      // may find nothing and this one still runs.
      for (const [key, seq] of Object.entries(registry)) {
        if (!key.startsWith(`${spec.name}.`)) continue;
        fields.push(key);
        columns[key] = seq.values.map((v) => v ?? '');
      }
    }

    tables[pool.name] = { name: pool.name, count: pool.count, fields, columns };
  }
  return tables;
}
