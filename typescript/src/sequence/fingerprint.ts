/**
 * Tuple fingerprints — Engine 5's data carrier.
 *
 * Engines 3 and 4 hunt duplicates by sorting the tuples THEMSELVES: text
 * records of eighty-odd characters, millions of JavaScript strings, each an
 * object the garbage collector has to track. That text is why the middle of a
 * big run is heavy — in scratch disk (5.8 GB of temp files for a 10 GB run),
 * in sort CPU (string comparisons), and in worker memory (chunks of live
 * strings plus the headroom V8 keeps for collecting them).
 *
 * None of it is needed to DETECT a duplicate. Detection only asks "are these
 * two the same?", and a hash answers that in 13 bytes:
 *
 *     [hi 4B][lo 4B][row index 5B]   big-endian, fixed width
 *
 * A 64-bit hash is not proof — two different tuples can collide — so a group
 * of records sharing a hash is a CANDIDATE, not a verdict. Candidates are few
 * (real duplicates plus a vanishing number of collisions: at ten million rows
 * the chance of even one false candidate is about 5e-6), and each is verified
 * by recomputing the actual tuples by row number, which the engine can do for
 * any row at any time. Verification makes the found duplicates EXACT — the
 * same rows engine 3's text sort names.
 *
 * Fixed width is its own reward, twice over. Sorting works on packed integer
 * arrays instead of strings — no allocation per record, no GC pressure, and a
 * pile of two million records is 26 MB instead of hundreds. And a record's
 * position in a file is `13 × ordinal`, so a sorted pile can be binary-searched
 * on disk: "is this tuple taken?" costs ~25 tiny reads and NO resident set at
 * all, which is what lets the repair run in bounded memory without the Bloom
 * filter's approximations.
 *
 * The 5-byte index covers 2^40 rows — a terabyte-scale run is ~10^10, three
 * orders of magnitude inside the limit.
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cyrb128 } from '../prng/prng.js';

/**
 * How many piles for a run of `count` rows.
 *
 * Enough that a pile is a small fraction of the whole, capped so the write
 * buffers stay modest and the file count stays sane. A short run gets one pile
 * — the signal to stay on the exact text path, where hashing has nothing to
 * pay for itself with.
 */
export function bucketCountFor(count: number, cores: number): number {
  if (count < 1_000_000) return 1;
  // Four piles per core: measured sizes come out even (124,575..126,065 over
  // sixteen piles at two million rows), so no core waits on a straggler.
  return Math.min(256, Math.max(2, Math.max(1, cores) * 4));
}

/** Bytes per record: 4 (hash hi) + 4 (hash lo) + 5 (row index). */
export const RECORD_BYTES = 13;

/** Rows a 5-byte index can name. Checked at the door rather than wrapped silently. */
export const MAX_INDEX = 2 ** 40;

/** The 64-bit fingerprint of a tuple key, as two 32-bit halves. */
export function hash64(key: string): { readonly hi: number; readonly lo: number } {
  const [h1, h2] = cyrb128(key);
  return { hi: h1, lo: h2 };
}

/**
 * Which pile a fingerprint belongs to.
 *
 * The same `h1 % buckets` the text piles use (`bucketOf` hashes the key with
 * cyrb128 and takes the first word), so the two routings agree — a tuple lands
 * in the same pile whichever carrier the engine runs on.
 */
export function fingerprintBucket(hi: number, buckets: number): number {
  return hi % buckets;
}

const WRITE_BATCH = 1 << 20;

/** Writes fingerprint records to a file, buffered. */
export class FingerprintWriter {
  private readonly fd: number;
  private buffer = Buffer.allocUnsafe(WRITE_BATCH);
  private used = 0;
  private written = 0;

  constructor(path: string) {
    this.fd = openSync(path, 'w');
  }

  write(hi: number, lo: number, index: number): void {
    if (index >= MAX_INDEX) {
      throw new Error(
        `fingerprint index ${String(index)} exceeds the 5-byte record limit (${String(MAX_INDEX)} rows)`,
      );
    }
    if (this.used + RECORD_BYTES > this.buffer.length) this.flush();
    const at = this.used;
    this.buffer.writeUInt32BE(hi >>> 0, at);
    this.buffer.writeUInt32BE(lo >>> 0, at + 4);
    // 5-byte big-endian index: one byte, then four.
    this.buffer.writeUInt8(Math.floor(index / 0x100000000), at + 8);
    this.buffer.writeUInt32BE(index >>> 0, at + 9);
    this.used += RECORD_BYTES;
    this.written += 1;
  }

  /** Records written so far. */
  get count(): number {
    return this.written;
  }

  private flush(): void {
    if (this.used > 0) writeSync(this.fd, this.buffer, 0, this.used);
    this.used = 0;
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

/**
 * Reads fingerprint records back, buffered, without allocating per record.
 * After a successful `next()` the current record sits in `hi`/`lo`/`index`.
 */
export class FingerprintReader {
  private readonly fd: number;
  private readonly buffer = Buffer.allocUnsafe(RECORD_BYTES * 4096);
  private have = 0;
  private at = 0;
  hi = 0;
  lo = 0;
  index = 0;

  constructor(path: string) {
    this.fd = openSync(path, 'r');
  }

  next(): boolean {
    if (this.at >= this.have) {
      this.have = readSync(this.fd, this.buffer, 0, this.buffer.length, null);
      this.at = 0;
      if (this.have === 0) return false;
    }
    const p = this.at;
    this.hi = this.buffer.readUInt32BE(p);
    this.lo = this.buffer.readUInt32BE(p + 4);
    this.index = this.buffer.readUInt8(p + 8) * 0x100000000 + this.buffer.readUInt32BE(p + 9);
    this.at += RECORD_BYTES;
    return true;
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** One in-memory batch of records, as parallel typed arrays — no strings anywhere. */
interface Batch {
  readonly hi: Uint32Array;
  readonly lo: Uint32Array;
  readonly index: Float64Array;
  readonly size: number;
}

/** Sort a batch's permutation by (hi, lo) and write it out in that order. */
function writeSortedBatch(batch: Batch, path: string): void {
  const perm = new Uint32Array(batch.size);
  for (let i = 0; i < batch.size; i++) perm[i] = i;
  /*
   * The TYPED array's own sort, not the generic one. The first version called
   * `Array.prototype.sort.call(perm, …)`, and V8's generic sort treats a typed
   * array as a plain object: it copies every element into a number dictionary
   * at ~40 bytes apiece — hundreds of megabytes of silent garbage for a
   * two-million-record batch. Invisible with memory to spare; fatal under a
   * capped heap, which is exactly how it was caught (the 20 GB proof run died
   * at 766 MB in that dictionary). TypedArray#sort works on the raw elements.
   *
   * Subtraction in the comparator is exact: both values are 32-bit and a
   * double carries the difference without rounding.
   *
   * The index breaks ties. Nothing downstream needs it — a candidate group's
   * rows are sorted before use — but it makes the sorted FILE a function of
   * its contents alone, so the records are ordered exactly as their 13
   * big-endian bytes compare. A port can then sort the raw bytes and be
   * certain it agrees, instead of reproducing a comparator.
   */
  const { hi, lo, index } = batch;
  perm.sort((a: number, b: number) => {
    const ha = hi[a] ?? 0;
    const hb = hi[b] ?? 0;
    if (ha !== hb) return ha - hb;
    const la = lo[a] ?? 0;
    const lb = lo[b] ?? 0;
    if (la !== lb) return la - lb;
    return (index[a] ?? 0) - (index[b] ?? 0);
  });
  const writer = new FingerprintWriter(path);
  try {
    for (let i = 0; i < batch.size; i++) {
      const p = perm[i] ?? 0;
      writer.write(batch.hi[p] ?? 0, batch.lo[p] ?? 0, batch.index[p] ?? 0);
    }
  } finally {
    writer.close();
  }
}

/** Records per in-RAM sort batch: 2M records is 26 MB of typed arrays. */
const SORT_BATCH = 2_000_000;

/**
 * Sort any number of fingerprint files into ONE sorted file at `outPath`.
 *
 * External merge sort over fixed-width records: batches sorted in typed
 * arrays, then a k-way merge holding one record per run. Bounded memory at
 * any input size — a pile from a terabyte run sorts the same way a small one
 * does, just through more runs.
 *
 * Returns the record count, which the binary search needs to know the file's
 * extent without a stat-and-divide at every query.
 */
export function sortFingerprintFiles(
  inputs: readonly string[],
  outPath: string,
  tmpRoot?: string,
  batchSize = SORT_BATCH,
): number {
  const dir = mkdtempSync(join(tmpRoot ?? tmpdir(), 'tdc-fp-sort-'));
  const runs: string[] = [];
  let total = 0;
  try {
    // Phase one: read every input, cut into sorted runs.
    let hi = new Uint32Array(batchSize);
    let lo = new Uint32Array(batchSize);
    let index = new Float64Array(batchSize);
    let fill = 0;
    const flush = (): void => {
      if (fill === 0) return;
      const path = join(dir, `run-${String(runs.length)}`);
      writeSortedBatch({ hi, lo, index, size: fill }, path);
      runs.push(path);
      fill = 0;
    };
    for (const input of inputs) {
      const reader = new FingerprintReader(input);
      try {
        while (reader.next()) {
          hi[fill] = reader.hi;
          lo[fill] = reader.lo;
          index[fill] = reader.index;
          fill += 1;
          total += 1;
          if (fill === batchSize) flush();
        }
      } finally {
        reader.close();
      }
    }
    flush();
    // Release the batch arrays before the merge — the merge needs none of it.
    hi = new Uint32Array(0);
    lo = new Uint32Array(0);
    index = new Float64Array(0);

    // Phase two: k-way merge of the runs. One record per run in memory.
    const readers = runs.map((p) => new FingerprintReader(p));
    const live: number[] = [];
    for (let r = 0; r < readers.length; r++) {
      if (readers[r]?.next()) live.push(r);
    }
    const writer = new FingerprintWriter(outPath);
    try {
      while (live.length > 0) {
        // Linear scan for the minimum: run counts are small (dozens), and a
        // heap earns its keep only past hundreds of runs.
        let best = 0;
        for (let i = 1; i < live.length; i++) {
          const a = readers[live[i] ?? 0];
          const b = readers[live[best] ?? 0];
          if (!a || !b) continue;
          if (
            a.hi < b.hi ||
            (a.hi === b.hi && (a.lo < b.lo || (a.lo === b.lo && a.index < b.index)))
          ) {
            best = i;
          }
        }
        const runId = live[best] ?? 0;
        const r = readers[runId];
        if (!r) break;
        writer.write(r.hi, r.lo, r.index);
        if (!r.next()) live.splice(best, 1);
      }
    } finally {
      writer.close();
      for (const r of readers) r.close();
    }
    return total;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Row-index groups that share a fingerprint, from a SORTED file.
 *
 * These are candidates, not verdicts: a 64-bit collision between different
 * tuples would land here too, so the caller recomputes the true tuples for
 * every group and keeps only the rows whose tuples genuinely repeat.
 */
export function* candidateGroups(sortedPath: string): Generator<readonly number[], void, void> {
  const reader = new FingerprintReader(sortedPath);
  try {
    let curHi = -1;
    let curLo = -1;
    let group: number[] = [];
    while (reader.next()) {
      if (reader.hi !== curHi || reader.lo !== curLo) {
        if (group.length >= 2) yield group;
        group = [];
        curHi = reader.hi;
        curLo = reader.lo;
      }
      group.push(reader.index);
    }
    if (group.length >= 2) yield group;
  } finally {
    reader.close();
  }
}

/**
 * "Is this tuple already taken?" — answered by binary search on the sorted
 * pile files, in no memory at all.
 *
 * This is the disk-ledger idea in its final form: the sorted fingerprints ARE
 * the ledger, and a lookup is ~25 record-sized reads. The repair asks this a
 * few thousand times, so the read count is irrelevant next to what building an
 * in-RAM structure over every row would cost.
 *
 * Rows being reassigned by the repair have their old tuples freed, so a match
 * counts only if some matching record's row is NOT in `moving`. And a 64-bit
 * collision can only make the answer "taken" for a free tuple — the repair
 * then picks another combination; it can never hide a taken one.
 */
export class FingerprintLedger {
  private readonly fds: number[];
  private readonly counts: number[];
  private readonly probe = Buffer.allocUnsafe(RECORD_BYTES);

  /** `sortedPaths[b]` must be pile `b`'s sorted file — lookups route by the pile hash. */
  constructor(
    private readonly sortedPaths: readonly string[],
    private readonly moving: ReadonlySet<number>,
  ) {
    this.fds = sortedPaths.map((p) => openSync(p, 'r'));
    this.counts = sortedPaths.map((p) => Math.floor(statSync(p).size / RECORD_BYTES));
  }

  has(key: string): boolean {
    const { hi, lo } = hash64(key);
    const pile = fingerprintBucket(hi, this.sortedPaths.length);
    const fd = this.fds[pile];
    const count = this.counts[pile] ?? 0;
    if (fd === undefined || count === 0) return false;

    // Lower bound for (hi, lo).
    let a = 0;
    let b = count;
    while (a < b) {
      const mid = (a + b) >>> 1;
      readSync(fd, this.probe, 0, RECORD_BYTES, mid * RECORD_BYTES);
      const mh = this.probe.readUInt32BE(0);
      const ml = this.probe.readUInt32BE(4);
      if (mh < hi || (mh === hi && ml < lo)) a = mid + 1;
      else b = mid;
    }
    // Walk the equal-fingerprint run: taken if any holder is not being moved.
    for (let at = a; at < count; at++) {
      readSync(fd, this.probe, 0, RECORD_BYTES, at * RECORD_BYTES);
      if (this.probe.readUInt32BE(0) !== hi || this.probe.readUInt32BE(4) !== lo) break;
      const row = this.probe.readUInt8(8) * 0x100000000 + this.probe.readUInt32BE(9);
      if (!this.moving.has(row)) return true;
    }
    return false;
  }

  close(): void {
    for (const fd of this.fds) closeSync(fd);
  }
}
