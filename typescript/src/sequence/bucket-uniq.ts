/**
 * Finding duplicate tuples by splitting them into piles — Engine 4's idea.
 *
 * Engine 3 puts every tuple through ONE sort. That sort is the largest single
 * stage of a big uniq run, and it cannot be split by row range without a final
 * merge over everything, because two rows in different ranges may be the pair
 * that collides. Measured on 10 GB: the merge and repair took five minutes of a
 * ten-minute run, on one core, while eleven waited.
 *
 * The way out is to choose the pile by a hash OF THE TUPLE. Equal tuples hash
 * equally, so a duplicate pair always lands in the same pile — and piles never
 * have to be compared with each other. Each is sorted and scanned on its own,
 * and nothing is merged across them.
 *
 * Measured on 2,000,000 rows, before any of this was wired to threads: one pile
 * 5.11 s, sixteen piles 3.84 s in total and 0.32 s for the largest. The first
 * number is what one core spends — the shape alone is cheaper. The second is
 * what the clock would show with a core per pile.
 *
 * The duplicates found are exactly the ones the single sort finds, and in the
 * same order, because a duplicate group lives entirely inside one pile and the
 * rows are reported by index. That is what makes this a speed change and not a
 * different answer: Engine 4 must produce the same bytes as Engine 3.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cyrb128 } from '../prng/prng.js';
import { externalSort, RunReader, RunWriter } from './external-sort.js';

/** Which pile a tuple belongs to. The hash all five implementations already carry. */
export function bucketOf(key: string, buckets: number): number {
  const [h] = cyrb128(key);
  return h % buckets;
}

/** A pile on disk: the records routed to it, and the file they live in. */
interface Pile {
  readonly path: string;
  readonly writer: RunWriter;
  count: number;
}

/**
 * The tuples, split into piles on disk.
 *
 * Records are written as they arrive and sorted later, one pile at a time, so
 * what is held in memory is one write buffer per pile rather than any part of
 * the data.
 */
export class TupleBuckets {
  private readonly dir: string;
  private readonly piles: Pile[];

  constructor(
    private readonly buckets: number,
    tmpRoot?: string,
  ) {
    this.dir = mkdtempSync(join(tmpRoot ?? tmpdir(), 'tdc-buckets-'));
    this.piles = Array.from({ length: buckets }, (_, k) => {
      const path = join(this.dir, `pile-${String(k)}.txt`);
      return { path, writer: new RunWriter(path), count: 0 };
    });
  }

  /** Route one record — `key + SEP + paddedIndex` — to its pile. */
  add(record: string, key: string): void {
    const pile = this.piles[bucketOf(key, this.buckets)];
    if (!pile) return;
    pile.writer.write(record);
    pile.count += 1;
  }

  /** No more records. The files can be read after this. */
  seal(): void {
    for (const pile of this.piles) pile.writer.close();
  }

  /** Every pile's file, in pile order — for a second pass over all the tuples. */
  paths(): readonly string[] {
    return this.piles.map((p) => p.path);
  }

  /** How many records each pile holds, for reporting how evenly they split. */
  sizes(): readonly number[] {
    return this.piles.map((p) => p.count);
  }

  /**
   * One pile's records, sorted.
   *
   * Sorted here rather than on the way in: a pile is a fraction of the run, so
   * its sort is a fraction of the work, and the piles are independent — which
   * is the whole point.
   */
  *sorted(pile: number, chunkSize?: number): Generator<string, void, void> {
    const path = this.piles[pile]?.path;
    if (path === undefined) return;
    const read = function* (): Generator<string> {
      const reader = new RunReader(path);
      try {
        for (let r = reader.next(); r !== undefined; r = reader.next()) yield r;
      } finally {
        reader.close();
      }
    };
    yield* externalSort(read(), {
      ...(chunkSize !== undefined ? { chunkSize } : {}),
      tmpDir: this.dir,
    });
  }

  drop(): void {
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Read records that already exist and route them into piles.
 *
 * Returns the files of each pile, in pile order. The records are not sorted
 * here — a pile is sorted by whoever processes it, which is the point: that
 * work is what gets spread.
 */
export function routeIntoPiles(
  sources: readonly string[],
  buckets: number,
  tmpRoot: string,
  separator: string,
): { readonly piles: readonly (readonly string[])[]; readonly drop: () => void } {
  const store = new TupleBuckets(buckets, tmpRoot);
  for (const path of sources) {
    const reader = new RunReader(path);
    try {
      for (let r = reader.next(); r !== undefined; r = reader.next()) {
        store.add(r, r.slice(0, r.lastIndexOf(separator)));
      }
    } finally {
      reader.close();
    }
  }
  store.seal();
  return {
    piles: store.paths().map((path) => [path]),
    drop: () => {
      store.drop();
    },
  };
}

/**
 * How many piles for a run of `count` rows.
 *
 * Enough that a pile is a small fraction of the whole, capped so the write
 * buffers stay modest and the file count stays sane. A short run gets one pile,
 * which is exactly what Engine 3 does.
 */
export function bucketCountFor(count: number, cores: number): number {
  if (count < 1_000_000) return 1;
  // Four piles per core: the sizes come out even enough (measured: 124,575 to
  // 126,065 over sixteen piles) that no core waits on a straggler.
  const wanted = Math.max(1, cores) * 4;
  return Math.min(256, Math.max(2, wanted));
}
