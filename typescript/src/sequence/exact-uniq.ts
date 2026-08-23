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
import { SeenTuples } from './tuple-filter.js';
import { mergeRuns, RunReader, RunWriter } from './external-sort.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const SEP = String.fromCharCode(0); // NUL — cannot appear in a generated value
const JOIN = String.fromCharCode(1); // SOH — column separator inside a tuple key
// Row index is zero-padded to a fixed width so `key\0<paddedIndex>` sorts by
// (key, index) under plain BYTE comparison — no per-comparison parsing. NUL is
// the smallest byte, so it terminates the key correctly even for prefixes.
const INDEX_WIDTH = 16; // covers counts up to 10^16 (> JS safe integer range)
// The bounded-memory repair is O(pool²); beyond this many colliding rows, defer
// to the in-memory engine instead. Real configs collide far less (birthday).
const MAX_REPAIR_ROWS = 20_000;

/**
 * Below this many rows the repair derives the tuples a second time rather than
 * writing them down. A file is worth its own cost only once the second pass is
 * measured in minutes; under a million rows it is measured in seconds. The
 * choice is pure speed — both paths build the same set, since membership does
 * not depend on the order things were added in.
 */
const JOURNAL_MIN_ROWS = 1_000_000;

export interface DuplicateScanOptions {
  /** Records held in RAM per sort run (passed to externalSort). */
  readonly chunkSize?: number;
  /** Directory for temp files. */
  readonly tmpDir?: string;
  /**
   * Called with every sorted record as it goes past.
   *
   * The repair has to look at every tuple a SECOND time, to learn which ones
   * are already taken. Computing them again costs what the scan cost: on a
   * 97,000,000-row run that was 18 minutes of a 61-minute total, spent
   * re-deriving values that had just been derived. The records are already in
   * hand here, so a caller can write them down instead and read them back.
   */
  readonly onRecord?: (record: string) => void;
  /**
   * Rows from which the repair writes the tuples down instead of deriving them
   * twice. Defaults to `JOURNAL_MIN_ROWS`.
   *
   * Both paths build the same set, so this is a speed choice — and a testable
   * one: lowering it lets a small config take the path a 97,000,000-row run
   * takes, and the two are then asserted to produce the same bytes. Without
   * that the path would only ever run on a config too big for a test suite,
   * which is how a path comes to be believed rather than known.
   */
  readonly journalMinRows?: number;
  /**
   * Tuple records already computed and sorted, in run files written elsewhere.
   *
   * The scan is a full pass over every row — compute the tuple, sort it in with
   * the rest — and it is the single most expensive stage of a uniq run. Each
   * row is a function of its own number and nothing else, so it splits: several
   * threads take a range apiece, sort what they produced, and hand the files
   * over. Given them, this does no computing and no sorting, only the merge.
   *
   * The files also stand in for the journal: they already hold every tuple, so
   * the repair reads them for its second look rather than writing its own copy.
   */
  readonly sortedRuns?: readonly string[];
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
  // Given sorted runs, the rows are never asked for: someone else already
  // computed them. Otherwise compute and sort them here, as before.
  const sorted =
    options.sortedRuns !== undefined && options.sortedRuns.length > 0
      ? mergeRuns(options.sortedRuns)
      : externalSort(encode(rows), {
          chunkSize: options.chunkSize,
          tmpDir: options.tmpDir,
        });

  for (const record of sorted) {
    options.onRecord?.(record);
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
 * couldn't place every row (a pathologically tight pool).
 *
 * A caller that CHOSE a bounded-memory engine for the user catches this and
 * falls back to the in-memory engine, which has the whole table to work with.
 * A caller the user forced into stream mode lets it through instead: loading
 * the whole table is the one thing that user asked not to happen, so the text
 * says what to change rather than claiming a fallback happened.
 */
export class ExactUniqRepairNeeded extends Error {
  constructor(
    readonly collisions: number,
    label: string,
  ) {
    super(
      `uniq ${label} is too tight to repair without holding the whole table ` +
        `(${String(collisions)} row(s) couldn't be placed) — run without mode="stream" ` +
        `so the in-memory engine can arrange it.`,
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
export interface UniqResolver {
  readonly id: string;
  readonly resolve: (i: number) => string;
}

/**
 * Compute and sort the tuple records for ONE range of rows, into run files.
 *
 * The scan thread's whole job. Each row's tuple depends on its own number and
 * nothing else, so a thread given rows 40,000,000 to 50,000,000 can produce
 * exactly the records the whole-file scan would produce there, sort them, and
 * hand the files over. The coordinator merges everyone's files, which is cheap
 * — the expensive part was the computing and the sorting, and that is what
 * split.
 *
 * Records are sorted in chunks so a thread holds `chunkSize` of them at a time,
 * not its whole range. The files are the CALLER's to delete.
 */
export function scanTupleRuns(
  resolvers: readonly UniqResolver[],
  from: number,
  to: number,
  dir: string,
  prefix: string,
  chunkSize = SCAN_CHUNK,
): string[] {
  const paths: string[] = [];
  let chunk: string[] = [];

  const flush = (): void => {
    if (chunk.length === 0) return;
    chunk.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const path = joinPath(dir, `${prefix}-${String(paths.length)}.txt`);
    const writer = new RunWriter(path);
    try {
      for (const record of chunk) writer.write(record);
    } finally {
      writer.close();
    }
    paths.push(path);
    chunk = [];
  };

  for (let i = from; i < to; i++) {
    chunk.push(`${tupleKeyAt(resolvers, i)}${SEP}${String(i).padStart(INDEX_WIDTH, '0')}`);
    if (chunk.length >= chunkSize) flush();
  }
  flush();
  return paths;
}

/** Records a scan thread holds at once before sorting them out to a file. */
const SCAN_CHUNK = 1_000_000;

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
  /**
   * Rows that may trade values with each other, named by a key per row.
   *
   * A `<switch>` member draws from a different list depending on another
   * column, so a male row's first name is not a value a female row may hold.
   * The repair rearranges values among pool rows, and without this it would
   * happily put `Megan` on a `Male` row: the tuple stays unique and the record
   * stops making sense. With it, the pool is arranged one block at a time and
   * donors come from the row's own block.
   *
   * Absent means one block holding everything, which is the ordinary case.
   */
  blockOf?: (row: number) => string,
  /**
   * How the answer travels between threads.
   *
   * The analysis is the expensive half of a uniq run and it is a function of
   * the config and the seed alone, so it is worth doing ONCE. `onComputed`
   * hands the result out; `preset` hands it back in, and a caller holding one
   * skips the analysis entirely. That is what lets several threads render
   * different row ranges of the same uniq config: one thread works out which
   * rows move where, the rest are told.
   *
   * The result is small — only the rows that actually moved, a few thousand on
   * a run of a hundred million — so it crosses a thread boundary cheaply.
   */
  plan?: {
    readonly preset?: Readonly<Record<string, readonly string[]>> | undefined;
    readonly onComputed?: ((moved: Record<string, readonly string[]>) => void) | undefined;
  },
): Record<string, Sequence> {
  if (plan?.preset !== undefined) return applyOverride(resolvers, toOverride(plan.preset));

  const tuples = function* (): Generator<KeyedRow> {
    for (let i = 0; i < count; i++) yield { index: i, key: tupleKeyAt(resolvers, i) };
  };

  /*
   * 1. Excess rows: keep the lowest index of each duplicate group, move the
   *    rest — and keep every tuple the scan computed, written down as it goes.
   *
   * Step 2 below needs a second look at all of them. Deriving them again is a
   * second full pass over the run, which is not a detail: measured on
   * 97,000,000 rows it was 18 minutes on top of the 23 the scan took. Writing
   * them down costs one sequential file and reads back in seconds.
   *
   * The file is only worth its own existence on a run big enough to have gone
   * to disk anyway. Small runs skip it and step 2 derives the values as before,
   * which is also what keeps their arrangement exactly what it was.
   */
  const journalFrom = options.journalMinRows ?? JOURNAL_MIN_ROWS;
  // Sorted runs already ARE every tuple written down, so there is nothing to
  // write again — step 2 reads those instead.
  const haveRuns = options.sortedRuns !== undefined && options.sortedRuns.length > 0;
  const journalDir =
    !haveRuns && count >= journalFrom ? mkdtempSync(joinPath(tmpdir(), 'tdc-uniq-')) : undefined;
  const journalPath = journalDir === undefined ? undefined : joinPath(journalDir, 'tuples');
  const journal = journalPath === undefined ? undefined : new RunWriter(journalPath);

  const excess: number[] = [];
  try {
    const scan =
      journal === undefined
        ? options
        : {
            ...options,
            onRecord: (r: string) => {
              journal.write(r);
            },
          };
    for (const group of findDuplicateGroups(tuples(), scan)) {
      for (let m = 1; m < group.length; m++) {
        const idx = group[m];
        if (idx !== undefined) excess.push(idx);
      }
    }
  } finally {
    journal?.close();
  }

  const k = resolvers.length;
  const dropJournal = (): void => {
    if (journalDir !== undefined) rmSync(journalDir, { recursive: true, force: true });
  };

  if (excess.length === 0) {
    dropJournal();
    plan?.onComputed?.({}); // nothing moved, and the other threads need to know that
    const clean: Record<string, Sequence> = {};
    for (const r of resolvers) clean[r.id] = { name: r.id, values: [], resolve: r.resolve };
    return clean;
  }
  // The pool repair is O(pool²). Collisions are FEW for a real config (birthday
  // bound); an excess this large means a pathological config — hand it to the
  // in-memory engine rather than blowing up.
  if (excess.length > MAX_REPAIR_ROWS) {
    dropJournal();
    throw new ExactUniqRepairNeeded(excess.length, label);
  }
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
    if (blockOf === undefined) {
      const stride = Math.max(1, Math.floor(count / donorTarget));
      for (let i = 0; i < count && pool.length - excess.length < donorTarget; i += stride) {
        if (!poolSet.has(i)) {
          pool.push(i);
          poolSet.add(i);
        }
      }
    } else {
      // Donors have to come from the row's OWN block, or they bring values it
      // is not allowed to hold. Wanted per block, in proportion to how many
      // rows of that block need moving.
      const wanted = new Map<string, number>();
      for (const row of excess) {
        const block = blockOf(row);
        wanted.set(block, (wanted.get(block) ?? 0) + 8);
      }
      for (const block of wanted.keys()) wanted.set(block, (wanted.get(block) ?? 0) + 24);
      const stride = Math.max(1, Math.floor(count / Math.max(1, donorTarget)));
      for (let i = 0; i < count; i += stride) {
        if (poolSet.has(i)) continue;
        const block = blockOf(i);
        const left = wanted.get(block);
        if (left === undefined || left <= 0) continue;
        wanted.set(block, left - 1);
        pool.push(i);
        poolSet.add(i);
      }
    }
  }
  pool.sort((a, b) => a - b);

  /*
   * Pool value space + the present NON-pool tuples that lie entirely within it
   * (the only tuples a rearranged pool row could clash with).
   *
   * This walks the whole run, so it is the one part of the repair whose size
   * follows the DATASET rather than the collisions — and on a large run it was
   * the part that died. `SeenTuples` keeps it exact while that is affordable
   * and switches to a fixed-size filter beyond, which can only ever make the
   * arrangement more cautious than it needs to be.
   */
  const poolColumns = resolvers.map((r) => pool.map((i) => r.resolve(i)));
  const poolSpace = poolColumns.map((col) => new Set(col));
  const forbidden = new SeenTuples(count);
  const inPoolSpace = (values: readonly string[]): boolean => {
    for (let j = 0; j < k; j++) {
      if (!poolSpace[j]?.has(values[j] ?? '')) return false;
    }
    return true;
  };

  if (haveRuns) {
    // The scan's own files, read straight through. Sorted per range rather than
    // globally, which changes nothing: this is only ever asked whether a tuple
    // is in it.
    for (const record of mergeRuns(options.sortedRuns ?? [])) {
      const split = record.lastIndexOf(SEP);
      if (poolSet.has(Number(record.slice(split + 1)))) continue; // being reassigned
      const key = record.slice(0, split);
      if (inPoolSpace(key.split(JOIN))) forbidden.add(key);
    }
  } else if (journalPath !== undefined) {
    // Read back what the scan already worked out. Sorted order rather than row
    // order, which changes nothing: this is only ever asked whether a tuple is
    // in it, and that does not depend on the order things went in.
    const reader = new RunReader(journalPath);
    try {
      for (let record = reader.next(); record !== undefined; record = reader.next()) {
        const split = record.lastIndexOf(SEP);
        if (poolSet.has(Number(record.slice(split + 1)))) continue; // being reassigned
        const key = record.slice(0, split);
        if (inPoolSpace(key.split(JOIN))) forbidden.add(key);
      }
    } finally {
      reader.close();
    }
  } else {
    for (let i = 0; i < count; i++) {
      if (poolSet.has(i)) continue; // pool rows are being reassigned
      const values: string[] = [];
      for (let j = 0; j < k; j++) values.push(resolvers[j]?.resolve(i) ?? '');
      if (inPoolSpace(values)) forbidden.add(values.join(JOIN));
    }
  }
  dropJournal();

  // 3. Arrange the pool's values into distinct tuples avoiding the present ones.
  //    One block at a time when the group has a switch member: values only ever
  //    move among rows that were allowed to hold them.
  const override = new Map<number, string[]>();
  const blocks = new Map<string, number[]>();
  pool.forEach((rowIndex, m) => {
    const block = blockOf === undefined ? '' : blockOf(rowIndex);
    const held = blocks.get(block);
    if (held) held.push(m);
    else blocks.set(block, [m]);
  });
  for (const positions of blocks.values()) {
    const columns = poolColumns.map((col) => positions.map((m) => col[m] ?? ''));
    const arranged = arrangeAvoiding(columns, forbidden, positions.length);
    if (arranged === null) throw new ExactUniqRepairNeeded(excess.length, label);
    positions.forEach((m, at) => {
      override.set(
        pool[m] ?? 0,
        arranged.map((col) => col[at] ?? ''),
      );
    });
  }

  if (plan?.onComputed) {
    const moved: Record<string, readonly string[]> = {};
    for (const [row, values] of override) moved[String(row)] = values;
    plan.onComputed(moved);
  }
  return applyOverride(resolvers, override);
}

/** The plain object form of an override, as it travels between threads. */
function toOverride(moved: Readonly<Record<string, readonly string[]>>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [row, values] of Object.entries(moved)) out.set(Number(row), [...values]);
  return out;
}

/**
 * Sequences that answer from the override where there is one and from the
 * original resolver everywhere else — which is all a repaired uniq column IS.
 */
function applyOverride(
  resolvers: readonly UniqResolver[],
  override: ReadonlyMap<number, readonly string[]>,
): Record<string, Sequence> {
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
  // Only ever asked, never added to — so anything that can answer will do, and
  // a plain Set still satisfies it.
  forbidden: { has(key: string): boolean },
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
