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
import { bucketOf, TupleBuckets } from './bucket-uniq.js';
import {
  candidateGroups,
  FingerprintLedger,
  FingerprintWriter,
  fingerprintBucket,
  hash64,
  sortFingerprintFiles,
} from './fingerprint.js';
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
  /**
   * Split the tuples into this many piles, chosen by a hash OF THE TUPLE, and
   * scan each pile on its own — Engine 4.
   *
   * Equal tuples hash equally, so a colliding pair is always in the same pile
   * and the piles never have to be compared with each other. That removes the
   * one merge over everything, which on 10 GB was five minutes of a ten-minute
   * run and the last stage still on a single core.
   *
   * The duplicates are the same ones, reported in the same order, so this
   * changes the speed and not the answer. Absent or 1 means one pile, which is
   * what Engine 3 does.
   */
  readonly buckets?: number;
  /** Called once with each pile's size and file, for reporting how evenly they split. */
  readonly onBuckets?: (sizes: readonly number[], paths: readonly string[]) => void;
  /**
   * The colliding rows, already found somewhere else.
   *
   * A pile can be sorted and scanned by anything that can read a file — it
   * needs no config, no packs and no registry, only the records. So the piles
   * can be handed to threads that know nothing about the run, and what comes
   * back is this: the rows that have to move. Given it, the scan is skipped
   * altogether.
   *
   * Must be every excess row, sorted ascending — the same list the scan would
   * have produced, or the repair will move the wrong rows.
   */
  readonly knownExcess?: readonly number[];
  /**
   * Hunt duplicates by FINGERPRINT instead of by tuple text — Engine 5.
   *
   * The scan writes 13-byte records (64-bit hash + row index) into piles and
   * sorts numbers instead of strings; groups sharing a hash are candidates,
   * verified by recomputing the true tuples for those few rows. The sorted
   * piles then stay on disk and answer the repair's "is this tuple taken?" by
   * binary search — no in-memory structure over the run at all.
   *
   * The value is the number of piles. Absent or <2 leaves Engine 3's text
   * path in charge.
   */
  readonly fingerprintBuckets?: number;
  /**
   * Sorted fingerprint pile files computed elsewhere (the parallel
   * coordinator), pile order. With `knownExcess` this skips the scan entirely
   * and goes straight to the arrangement, reading nothing but these.
   */
  readonly fingerprintFiles?: readonly string[];
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
  if ((options.buckets ?? 1) > 1) {
    yield* bucketedDuplicateGroups(rows, options);
    return;
  }

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

/**
 * The same groups, found pile by pile.
 *
 * Every record is routed to a pile by the hash of its tuple, then each pile is
 * sorted and scanned alone. Groups come out in pile order rather than in global
 * key order — which no caller depends on, since the rows are reported by index
 * and the caller sorts them.
 */
function* bucketedDuplicateGroups(
  rows: Iterable<KeyedRow>,
  options: DuplicateScanOptions,
): Generator<readonly number[], void, void> {
  const buckets = options.buckets ?? 1;
  const piles = new TupleBuckets(buckets, options.tmpDir);
  try {
    /*
     * Route from whatever the tuples are already in.
     *
     * When threads have computed them, they are on disk and reading them back
     * costs a sequential pass; deriving them again costs a full generation of
     * the run. This used to take the second road without noticing, because the
     * pile branch was chosen before anyone asked whether the records already
     * existed.
     */
    if (options.sortedRuns !== undefined && options.sortedRuns.length > 0) {
      for (const path of options.sortedRuns) {
        const reader = new RunReader(path);
        try {
          for (let r = reader.next(); r !== undefined; r = reader.next()) {
            piles.add(r, r.slice(0, r.lastIndexOf(SEP)));
          }
        } finally {
          reader.close();
        }
      }
    } else {
      for (const { index, key } of rows) {
        piles.add(`${key}${SEP}${String(index).padStart(INDEX_WIDTH, '0')}`, key);
      }
    }
    piles.seal();
    options.onBuckets?.(piles.sizes(), piles.paths());

    for (let pile = 0; pile < buckets; pile++) {
      let currentKey: string | undefined;
      let group: number[] = [];
      for (const record of piles.sorted(pile, options.chunkSize)) {
        options.onRecord?.(record);
        const split = record.lastIndexOf(SEP);
        const key = record.slice(0, split);
        const index = Number(record.slice(split + 1));
        if (key !== currentKey) {
          if (group.length >= 2) yield group;
          group = [];
          currentKey = key;
        }
        group.push(index);
      }
      if (group.length >= 2) yield group;
    }
  } finally {
    piles.drop();
  }
}

/**
 * The rows that have to move, from a stream of tuple records.
 *
 * One pile's worth of work, with nothing else attached: sort the records, and
 * every row after the first of each repeated tuple is a row that must be
 * rearranged. Kept separate from `repairExactUniq` so a thread can do it
 * knowing only the files — no config, no packs, no registry.
 */
export function excessFromRecords(
  records: Iterable<string>,
  options: { chunkSize?: number | undefined; tmpDir?: string | undefined } = {},
): number[] {
  const excess: number[] = [];
  let currentKey: string | undefined;
  let group: number[] = [];

  const flush = (): void => {
    for (let m = 1; m < group.length; m++) {
      const idx = group[m];
      if (idx !== undefined) excess.push(idx);
    }
  };

  for (const record of externalSort(records, {
    ...(options.chunkSize !== undefined ? { chunkSize: options.chunkSize } : {}),
    ...(options.tmpDir !== undefined ? { tmpDir: options.tmpDir } : {}),
  })) {
    const split = record.lastIndexOf(SEP);
    const key = record.slice(0, split);
    if (key !== currentKey) {
      flush();
      group = [];
      currentKey = key;
    }
    group.push(Number(record.slice(split + 1)));
  }
  flush();
  excess.sort((a, b) => a - b);
  return excess;
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

/**
 * Compute one range of rows and route each tuple straight into its pile —
 * Engine 4's scan thread.
 *
 * The difference from `scanTupleRuns` is where the sorting happens. There, a
 * thread sorts its own range and the coordinator merges everyone's runs, in one
 * thread, over every record. Here nothing is sorted yet: each record goes
 * directly to the file of the pile its tuple hashes to, and the sorting is done
 * later, per pile, by whoever picks that pile up. Both phases are then spread,
 * and no pass over everything is left in the middle.
 *
 * Returns one file per pile, in pile order — this thread's share of each.
 */
export function scanIntoPiles(
  resolvers: readonly UniqResolver[],
  from: number,
  to: number,
  dir: string,
  prefix: string,
  buckets: number,
): string[] {
  const writers: RunWriter[] = [];
  const paths: string[] = [];
  for (let b = 0; b < buckets; b++) {
    const path = joinPath(dir, `${prefix}-pile-${String(b)}.txt`);
    paths.push(path);
    writers.push(new RunWriter(path));
  }
  try {
    for (let i = from; i < to; i++) {
      const key = tupleKeyAt(resolvers, i);
      writers[bucketOf(key, buckets)]?.write(`${key}${SEP}${String(i).padStart(INDEX_WIDTH, '0')}`);
    }
  } finally {
    for (const writer of writers) writer.close();
  }
  return paths;
}

/** What the fingerprint path knows: the sorted piles, their temp home, the verified excess. */
interface FingerprintScan {
  readonly sorted: readonly string[];
  readonly ownDir?: string;
  readonly excess: readonly number[];
}

/**
 * Run — or accept — the fingerprint scan. Undefined means the text machinery
 * stays in charge.
 *
 * Handed files and a known excess (the parallel coordinator's case), nothing
 * is computed here at all. Otherwise every row's tuple is hashed into 13-byte
 * records routed straight to pile files, each pile is sorted as packed
 * integers, and the groups that share a hash become candidates.
 *
 * Candidates are then VERIFIED: the true tuples for those few rows are
 * recomputed and only genuine repeats survive. That is what makes the excess
 * exact — the same rows the text sort would have named — while a 64-bit
 * collision between different tuples costs one wasted recomputation and
 * nothing else.
 */
function resolveFingerprints(
  resolvers: readonly UniqResolver[],
  count: number,
  options: DuplicateScanOptions,
): FingerprintScan | undefined {
  if (
    options.fingerprintFiles !== undefined &&
    options.fingerprintFiles.length > 0 &&
    options.knownExcess !== undefined
  ) {
    return { sorted: options.fingerprintFiles, excess: options.knownExcess };
  }

  const buckets = options.fingerprintBuckets ?? 1;
  if (buckets < 2) return undefined;

  const dir = mkdtempSync(joinPath(options.tmpDir ?? tmpdir(), 'tdc-fp-'));
  // Route every row's fingerprint to its pile.
  const rawPaths: string[] = [];
  const writers: FingerprintWriter[] = [];
  for (let b = 0; b < buckets; b++) {
    const path = joinPath(dir, `raw-${String(b)}`);
    rawPaths.push(path);
    writers.push(new FingerprintWriter(path));
  }
  for (let i = 0; i < count; i++) {
    const { hi, lo } = hash64(tupleKeyAt(resolvers, i));
    writers[fingerprintBucket(hi, buckets)]?.write(hi, lo, i);
  }
  for (const w of writers) w.close();

  // Sort each pile and collect the candidate groups.
  const sorted: string[] = [];
  const candidates: (readonly number[])[] = [];
  for (let b = 0; b < buckets; b++) {
    const out = joinPath(dir, `sorted-${String(b)}`);
    sortFingerprintFiles([rawPaths[b] ?? ''], out, dir);
    rmSync(rawPaths[b] ?? '', { force: true });
    sorted.push(out);
    for (const group of candidateGroups(out)) candidates.push(group);
  }

  return { sorted, ownDir: dir, excess: verifyCandidates(resolvers, candidates) };
}

/**
 * Keep only the rows whose tuples GENUINELY repeat, lowest row of each group
 * spared — exactly the rule the text scan applies.
 */
export function verifyCandidates(
  resolvers: readonly UniqResolver[],
  candidates: readonly (readonly number[])[],
): number[] {
  const excess: number[] = [];
  for (const group of candidates) {
    const byKey = new Map<string, number[]>();
    for (const row of group) {
      const key = tupleKeyAt(resolvers, row);
      const held = byKey.get(key);
      if (held) held.push(row);
      else byKey.set(key, [row]);
    }
    for (const rows of byKey.values()) {
      if (rows.length < 2) continue; // a hash collision, not a duplicate
      rows.sort((a, b) => a - b);
      for (let m = 1; m < rows.length; m++) {
        const row = rows[m];
        if (row !== undefined) excess.push(row);
      }
    }
  }
  excess.sort((a, b) => a - b);
  return excess;
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
  /*
   * Engine 5's carrier: fingerprints instead of tuple text.
   *
   * `fingerprint` collects everything the fingerprint path knows — the sorted
   * pile files, their temp home if this call created them, and the verified
   * excess. When it is set, the text machinery below (journal, sortedRuns,
   * SeenTuples) is BYPASSED wholesale: excess is already exact, and the sorted
   * piles answer the repair's membership question by binary search.
   */
  const fingerprint = resolveFingerprints(resolvers, count, options);

  const journalFrom = options.journalMinRows ?? JOURNAL_MIN_ROWS;
  // Sorted runs already ARE every tuple written down, so there is nothing to
  // write again — step 2 reads those instead.
  const haveRuns = options.sortedRuns !== undefined && options.sortedRuns.length > 0;
  const journalDir =
    fingerprint === undefined && !haveRuns && count >= journalFrom
      ? mkdtempSync(joinPath(tmpdir(), 'tdc-uniq-'))
      : undefined;
  const journalPath = journalDir === undefined ? undefined : joinPath(journalDir, 'tuples');
  const journal = journalPath === undefined ? undefined : new RunWriter(journalPath);

  const excess: number[] = [];
  if (fingerprint !== undefined) {
    excess.push(...fingerprint.excess);
    journal?.close();
  } else if (options.knownExcess !== undefined) {
    // Someone else scanned the piles. Nothing to compute here.
    excess.push(...options.knownExcess);
    journal?.close();
  } else
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
  /*
   * Separate from the journal on purpose: the journal is read once, before the
   * arrangement, but the fingerprint files are the LEDGER the arrangement
   * queries — they have to outlive it. Piles this call created live in their
   * own temp home; piles handed in from outside are the coordinator's to
   * remove.
   */
  const dropFingerprints = (): void => {
    if (fingerprint?.ownDir !== undefined) {
      rmSync(fingerprint.ownDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  };

  if (excess.length === 0) {
    dropJournal();
    dropFingerprints();
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
    dropFingerprints();
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
  const inPoolSpace = (values: readonly string[]): boolean => {
    for (let j = 0; j < k; j++) {
      if (!poolSpace[j]?.has(values[j] ?? '')) return false;
    }
    return true;
  };

  /*
   * The membership question, answered one of two ways.
   *
   * Text path: build a structure in memory over every row's tuple — exact
   * below two million keys, a Bloom filter past that.
   *
   * Fingerprint path: no structure at all. The sorted piles on disk ARE the
   * ledger, a query is a binary search of ~25 record-sized reads, and the
   * answers are exact — with one one-sided caveat: a 64-bit collision can call
   * a free tuple taken (the repair picks another), never a taken one free.
   */
  let forbidden: { has(key: string): boolean };
  let ledger: FingerprintLedger | undefined;
  if (fingerprint !== undefined) {
    ledger = new FingerprintLedger(fingerprint.sorted, poolSet);
    forbidden = ledger;
  } else {
    const seen = new SeenTuples(count);
    forbidden = seen;
    buildSeenTuples(seen);
  }

  function buildSeenTuples(seen: SeenTuples): void {
    const forbid = (key: string, row: number): void => {
      if (poolSet.has(row)) return; // being reassigned
      if (inPoolSpace(key.split(JOIN))) seen.add(key);
    };
    if (haveRuns) {
      // The scan's own files, read straight through. Sorted per range rather
      // than globally, which changes nothing: this is only ever asked whether
      // a tuple is in it.
      for (const record of mergeRuns(options.sortedRuns ?? [])) {
        const split = record.lastIndexOf(SEP);
        forbid(record.slice(0, split), Number(record.slice(split + 1)));
      }
    } else if (journalPath !== undefined) {
      // Read back what the scan already worked out. Sorted order rather than
      // row order, which changes nothing: membership does not depend on the
      // order things went in.
      const reader = new RunReader(journalPath);
      try {
        for (let record = reader.next(); record !== undefined; record = reader.next()) {
          const split = record.lastIndexOf(SEP);
          forbid(record.slice(0, split), Number(record.slice(split + 1)));
        }
      } finally {
        reader.close();
      }
    } else {
      for (let i = 0; i < count; i++) {
        if (poolSet.has(i)) continue; // pool rows are being reassigned
        const values: string[] = [];
        for (let j = 0; j < k; j++) values.push(resolvers[j]?.resolve(i) ?? '');
        if (inPoolSpace(values)) seen.add(values.join(JOIN));
      }
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
    if (arranged === null) {
      ledger?.close();
      dropFingerprints();
      throw new ExactUniqRepairNeeded(excess.length, label);
    }
    positions.forEach((m, at) => {
      override.set(
        pool[m] ?? 0,
        arranged.map((col) => col[at] ?? ''),
      );
    });
  }

  ledger?.close();
  dropFingerprints();

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
