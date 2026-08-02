/**
 * Engine 3 — scalable uniqueness (detection + repair) via external memory.
 *
 * Engine 1 makes tuples unique with an O(N²) in-RAM swap-repair. Engine 3 does
 * the same job past RAM by sorting on disk. Stages:
 *   2. duplicate detection (findDuplicateGroups / countDuplicates)
 *   3. exact-% construction + verification (arrangeExactUniq): generate each
 *      column with EXACT percentages seekably (Feistel quota, O(1) memory),
 *      then verify uniqueness externally. No collisions → done (the common,
 *      ample-slack case) with byte-exact marginals.
 *   4. repair (repairExactUniq): when the tight construction DID collide, the
 *      collisions are FEW (birthday bound). Collect them + donor rows into a
 *      small pool, learn (one pass) which present tuples the pool could clash
 *      with, and rearrange the pool into distinct tuples avoiding those — all
 *      in RAM, preserving each column's multiset so marginals stay exact.
 *      Only a pathologically tight pool that can't be solved throws
 *      `ExactUniqRepairNeeded` (→ caller falls back to the in-memory engine).
 *
 * Assumes tuple keys contain no NUL byte (char code 0); the builder that forms
 * keys controls the join, so this holds.
 */

import { computeCountsPerValue } from '../distribution/hamilton.js';
import { permuteKey } from '../prng/permute.js';
import { createPrng } from '../prng/prng.js';

import { externalSort } from './external-sort.js';
import { makePercentResolver } from './stream-resolve.js';
import type { Sequence } from './types.js';
import { arrangeUnique, uniqUpperBound } from './uniq.js';

const SEP = String.fromCharCode(0); // NUL — cannot appear in a generated value
const JOIN = String.fromCharCode(1); // SOH — column separator inside a tuple key
// Row index is zero-padded to a fixed width so `key\0<paddedIndex>` sorts by
// (key, index) under plain BYTE comparison — no per-comparison parsing. NUL is
// the smallest byte, so it terminates the key correctly even for prefixes.
const INDEX_WIDTH = 16; // covers counts up to 10^16 (> JS safe integer range)
// The bounded-memory repair is O(pool²); beyond this many colliding rows, defer
// to the in-memory engine instead. Real configs collide far less (birthday).
const MAX_REPAIR_ROWS = 20_000;

export interface DuplicateScanOptions {
  /** Records held in RAM per sort run (passed to externalSort). */
  readonly chunkSize?: number;
  /** Directory for temp files. */
  readonly tmpDir?: string;
}

/** A row and the key of its tuple (the concatenation of its uniq'd columns). */
export interface KeyedRow {
  readonly index: number;
  readonly key: string;
}

/**
 * Stream groups of row indices whose tuple key is identical — size ≥ 2, i.e.
 * exactly the collisions to repair. Input `(index, key)` in any order; scales
 * past RAM via external sort. Groups come in sorted-key order, indices within a
 * group ascending (deterministic).
 */
export function* findDuplicateGroups(
  rows: Iterable<KeyedRow>,
  options: DuplicateScanOptions = {},
): Generator<readonly number[], void, void> {
  let currentKey: string | undefined;
  let group: number[] = [];

  // No custom comparator — the padded encoding sorts correctly byte-wise, which
  // is far cheaper than parsing each record on every comparison.
  for (const record of externalSort(encode(rows), {
    chunkSize: options.chunkSize,
    tmpDir: options.tmpDir,
  })) {
    const split = record.lastIndexOf(SEP);
    const key = record.slice(0, split);
    const index = Number(record.slice(split + 1)); // leading zeros are ignored
    if (key !== currentKey) {
      if (group.length >= 2) yield group;
      group = [];
      currentKey = key;
    }
    group.push(index);
  }
  if (group.length >= 2) yield group;
}

/** Total DUPLICATE rows (rows beyond the first in each colliding group). */
export function countDuplicates(
  rows: Iterable<KeyedRow>,
  options: DuplicateScanOptions = {},
): number {
  let extra = 0;
  for (const group of findDuplicateGroups(rows, options)) extra += group.length - 1;
  return extra;
}

function* encode(rows: Iterable<KeyedRow>): Generator<string> {
  for (const { index, key } of rows) {
    yield `${key}${SEP}${String(index).padStart(INDEX_WIDTH, '0')}`;
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — exact-% construction + verification
// ---------------------------------------------------------------------------

/** One uniq column: registry id, its value pool, and per-value percentages. */
export interface ExactUniqField {
  readonly id: string;
  readonly values: readonly string[];
  readonly percents: readonly number[];
}

/**
 * Signals that the exact-% construction collided AND the bounded-memory repair
 * couldn't place every row (a pathologically tight pool). Callers catch this
 * and fall back to the in-memory engine, which has the whole table to work with.
 */
export class ExactUniqRepairNeeded extends Error {
  constructor(
    readonly collisions: number,
    label: string,
  ) {
    super(
      `Engine 3: uniq ${label} is too tight for the bounded-memory repair ` +
        `(${String(collisions)} row(s) couldn't be placed) — using the in-memory engine instead.`,
    );
    this.name = 'ExactUniqRepairNeeded';
  }
}

/**
 * Build seekable exact-% resolvers for the uniq columns and VERIFY the tuples
 * are unique (externally, bounded memory). On success returns the resolvers —
 * O(1) memory, byte-exact per-column marginals, verified distinct. Throws a
 * feasibility error if `count` exceeds the provable capacity, or
 * `ExactUniqRepairNeeded` if construction collides (tight config).
 */
export function arrangeExactUniq(
  fields: readonly ExactUniqField[],
  count: number,
  seed: string,
  label: string,
  options: DuplicateScanOptions = {},
): Record<string, Sequence> {
  const columnCounts = fields.map((f) =>
    computeCountsPerValue(count, [...f.percents], createPrng(`${seed}|${f.id}|pct`)),
  );
  const upper = uniqUpperBound(columnCounts);
  if (count > upper) {
    throw new Error(
      `uniq ${label} is infeasible — its data supports at most ${String(upper)} distinct ` +
        `rows, but ${String(count)} were requested. Widen a column's values or lower count.`,
    );
  }

  const resolvers = fields.map((f, j) => ({
    id: f.id,
    resolve: makePercentResolver(
      [...f.values],
      columnCounts[j] ?? [],
      count,
      permuteKey(seed, f.id),
    ),
  }));

  const registryOf = (rs: readonly UniqResolver[]): Record<string, Sequence> => {
    const out: Record<string, Sequence> = {};
    for (const r of rs) out[r.id] = { name: r.id, values: [], resolve: r.resolve };
    return out;
  };

  // Fast path: if any column is INJECTIVE (each value used at most once), the
  // tuple is unique by that column alone — no need to verify O(N log N).
  if (columnCounts.some((counts) => counts.every((c) => c <= 1))) {
    return registryOf(resolvers);
  }

  // Otherwise verify uniqueness; a tight construction that collided is repaired
  // (stage 4). Both bounded-memory.
  return repairExactUniq(resolvers, count, label, options);
}

/** A uniq column resolver: its registry id and its exact-% value(i). */
interface UniqResolver {
  readonly id: string;
  readonly resolve: (i: number) => string;
}

function tupleKeyAt(resolvers: readonly UniqResolver[], i: number): string {
  let key = '';
  for (let r = 0; r < resolvers.length; r++) {
    if (r > 0) key += JOIN;
    key += resolvers[r]?.resolve(i) ?? '';
  }
  return key;
}

/**
 * Verify uniqueness and, if the exact-% construction left collisions, repair
 * them while preserving each column's multiset (so marginals stay exact).
 *
 * The collisions are FEW (birthday bound: capacity ≫ count² → none; between
 * count and count² → ~count²/2·capacity). So:
 *   1. dedup (external) → the "excess" rows that must move (small).
 *   2. one pass over all rows → the present tuples that lie inside the excess
 *      rows' value space (the only tuples a repaired row could clash with; small).
 *   3. re-arrange the excess rows' freed values into DISTINCT tuples that avoid
 *      those present ones — all in RAM. An override map (small) layers over the
 *      seekable resolvers.
 * If the tiny sub-problem can't be solved (pathologically tight), throw
 * `ExactUniqRepairNeeded` so the caller falls back to the in-memory engine.
 */
export function repairExactUniq(
  resolvers: readonly UniqResolver[],
  count: number,
  label: string,
  options: DuplicateScanOptions = {},
): Record<string, Sequence> {
  const tuples = function* (): Generator<KeyedRow> {
    for (let i = 0; i < count; i++) yield { index: i, key: tupleKeyAt(resolvers, i) };
  };

  // 1. Excess rows: keep the lowest index of each duplicate group, move the rest.
  const excess: number[] = [];
  for (const group of findDuplicateGroups(tuples(), options)) {
    for (let m = 1; m < group.length; m++) {
      const idx = group[m];
      if (idx !== undefined) excess.push(idx);
    }
  }
  const k = resolvers.length;
  if (excess.length === 0) {
    const clean: Record<string, Sequence> = {};
    for (const r of resolvers) clean[r.id] = { name: r.id, values: [], resolve: r.resolve };
    return clean;
  }
  // The pool repair is O(pool²). Collisions are FEW for a real config (birthday
  // bound); an excess this large means a pathological config — hand it to the
  // in-memory engine rather than blowing up.
  if (excess.length > MAX_REPAIR_ROWS) throw new ExactUniqRepairNeeded(excess.length, label);
  excess.sort((a, b) => a - b);

  // 2. The excess rows alone often lack the value diversity to move (e.g. a
  // single duplicate can only re-form its own tuple). So build a REPAIR POOL =
  // excess rows + donor rows sampled evenly across the dataset. Rearranging the
  // whole pool (preserving its multiset) gives room to place everything, and
  // the global marginals stay exact because only pool rows move among pool
  // values. Pool stays small (collisions are few).
  const donorTarget = Math.min(count - excess.length, 8 * excess.length + 24);
  const pool = [...excess];
  const poolSet = new Set(excess);
  if (donorTarget > 0) {
    const stride = Math.max(1, Math.floor(count / donorTarget));
    for (let i = 0; i < count && pool.length - excess.length < donorTarget; i += stride) {
      if (!poolSet.has(i)) {
        pool.push(i);
        poolSet.add(i);
      }
    }
  }
  pool.sort((a, b) => a - b);

  // Pool value space + the present NON-pool tuples that lie entirely within it
  // (the only tuples a rearranged pool row could clash with).
  const poolColumns = resolvers.map((r) => pool.map((i) => r.resolve(i)));
  const poolSpace = poolColumns.map((col) => new Set(col));
  const forbidden = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (poolSet.has(i)) continue; // pool rows are being reassigned
    let key = '';
    let inSpace = true;
    for (let j = 0; j < k; j++) {
      const value = resolvers[j]?.resolve(i) ?? '';
      if (!poolSpace[j]?.has(value)) {
        inSpace = false;
        break;
      }
      if (j > 0) key += JOIN;
      key += value;
    }
    if (inSpace) forbidden.add(key);
  }

  // 3. Arrange the pool's values into distinct tuples avoiding the present ones.
  const arranged = arrangeAvoiding(poolColumns, forbidden, pool.length);
  if (arranged === null) throw new ExactUniqRepairNeeded(excess.length, label);

  const override = new Map<number, string[]>();
  pool.forEach((rowIndex, m) => {
    override.set(
      rowIndex,
      arranged.map((col) => col[m] ?? ''),
    );
  });

  const out: Record<string, Sequence> = {};
  resolvers.forEach((r, j) => {
    out[r.id] = {
      name: r.id,
      values: [],
      resolve: (i: number): string => {
        const ov = override.get(i);
        return ov ? (ov[j] ?? '') : r.resolve(i);
      },
    };
  });
  return out;
}

/**
 * Rearrange each column (a permutation of its freed multiset) so the E tuples
 * are distinct AND none is in `forbidden`. Small E → an O(E²) swap repair on
 * top of `arrangeUnique`. Returns the arranged columns, or null if it can't.
 */
function arrangeAvoiding(
  columns: readonly (readonly string[])[],
  forbidden: ReadonlySet<string>,
  size: number,
): string[][] | null {
  const k = columns.length;
  if (size === 0 || k === 0) return columns.map((c) => [...c]);

  const arr = arrangeUnique(columns).columns; // distinct among themselves
  const rows: string[][] = Array.from({ length: size }, (_, i) => arr.map((c) => c[i] ?? ''));
  const keyOf = (row: readonly string[]): string => row.join(JOIN);

  for (let sweep = 0; sweep < 32; sweep++) {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
    const bad = (key: string): boolean => (counts.get(key) ?? 0) > 1 || forbidden.has(key);

    let improved = false;
    for (let i = 0; i < size; i++) {
      const ri = rows[i];
      if (!ri) continue;
      // `ri` is fixed for the whole partner scan below, so its key and its
      // verdict are computed once. They used to be rebuilt — a `join` over
      // every column — on every candidate partner.
      const kri = keyOf(ri);
      if (!bad(kri)) continue;
      let done = false;
      for (let col = 0; col < k && !done; col++) {
        for (let j = 0; j < size && !done; j++) {
          const rj = rows[j];
          if (j === i || !rj || ri[col] === rj[col]) continue;
          const ni = ri.slice();
          const nj = rj.slice();
          ni[col] = rj[col] ?? '';
          nj[col] = ri[col] ?? '';
          const krj = keyOf(rj);
          const kni = keyOf(ni);
          const knj = keyOf(nj);
          // `ri` is bad — that is why we are scanning for a partner at all —
          // so its contribution is a fixed 1.
          const beforeBad = 1 + (bad(krj) ? 1 : 0);
          // The swap moves exactly two rows, so only four tallies can change.
          // This used to copy the whole `counts` map to find that out — an
          // O(rows) allocation inside the innermost loop, which made a sweep
          // cubic in the row count and turned 19,000 rows into a hang.
          const after = (key: string): number =>
            (counts.get(key) ?? 0) +
            (key === kni ? 1 : 0) +
            (key === knj ? 1 : 0) -
            (key === kri ? 1 : 0) -
            (key === krj ? 1 : 0);
          const badTrial = (key: string): boolean => after(key) > 1 || forbidden.has(key);
          const afterBad = (badTrial(kni) ? 1 : 0) + (badTrial(knj) ? 1 : 0);
          if (afterBad < beforeBad) {
            rows[i] = ni;
            rows[j] = nj;
            counts.set(kri, (counts.get(kri) ?? 0) - 1);
            counts.set(krj, (counts.get(krj) ?? 0) - 1);
            counts.set(kni, (counts.get(kni) ?? 0) + 1);
            counts.set(knj, (counts.get(knj) ?? 0) + 1);
            improved = true;
            done = true;
          }
        }
      }
    }
    if (!improved) break;
  }

  const finalCounts = new Map<string, number>();
  for (const row of rows) finalCounts.set(keyOf(row), (finalCounts.get(keyOf(row)) ?? 0) + 1);
  for (const row of rows) {
    const key = keyOf(row);
    if ((finalCounts.get(key) ?? 0) > 1 || forbidden.has(key)) return null;
  }
  return columns.map((_, j) => rows.map((row) => row[j] ?? ''));
}
