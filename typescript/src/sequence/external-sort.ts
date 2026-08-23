/**
 * External merge sort — sort a stream of records larger than RAM.
 *
 * Foundation for Engine 3's scalable uniqueness: to guarantee no duplicate
 * tuples across billions of rows you must sort them so equal tuples become
 * adjacent, and that sort has to run in bounded memory. Classic two-phase
 * algorithm:
 *   1. Read the input in chunks of `chunkSize` records, sort each chunk in
 *      RAM, and write it to a temp "run" file. → K sorted runs on disk.
 *   2. K-way merge the runs with a min-heap of their current heads, streaming
 *      the fully-sorted result. Only K record heads live in RAM at once.
 *
 * Small inputs (≤ one chunk) never touch disk. Deterministic: the comparator
 * fully orders records (ties broken by run index during the merge).
 *
 * Records must not contain the record separator `\n`.
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CHUNK = 1_000_000;
const WRITE_BATCH = 1 << 20;
const READ_BUFFER = 1 << 16;

export interface ExternalSortOptions {
  /** Records held in RAM per run (Phase 1). Smaller → more, smaller runs. */
  readonly chunkSize?: number | undefined;
  /** Directory for temp run files (default: OS temp). */
  readonly tmpDir?: string | undefined;
  /** Total order over records. Default: byte-wise (`<`/`>`). */
  readonly compare?: ((a: string, b: string) => number) | undefined;
}

/** A min-heap ordered by `cmp` (no non-null assertions, for strict lint). */
class MinHeap<T> {
  private readonly a: T[] = [];
  constructor(private readonly cmp: (x: T, y: T) => number) {}

  get size(): number {
    return this.a.length;
  }

  push(value: T): void {
    const a = this.a;
    a.push(value);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      const ai = a[i];
      const ap = a[p];
      if (ai === undefined || ap === undefined || this.cmp(ai, ap) >= 0) break;
      a[i] = ap;
      a[p] = ai;
      i = p;
    }
  }

  pop(): T {
    const a = this.a;
    const top = a[0];
    if (top === undefined) throw new Error('pop from empty heap');
    const last = a.pop();
    if (last !== undefined && a.length > 0) {
      a[0] = last;
      this.siftDown();
    }
    return top;
  }

  private siftDown(): void {
    const a = this.a;
    const n = a.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let s = i;
      const as = a[s];
      const al = l < n ? a[l] : undefined;
      if (al !== undefined && as !== undefined && this.cmp(al, as) < 0) s = l;
      const cur = a[s];
      const ar = r < n ? a[r] : undefined;
      if (ar !== undefined && cur !== undefined && this.cmp(ar, cur) < 0) s = r;
      if (s === i) break;
      const ai = a[i];
      const asv = a[s];
      if (ai === undefined || asv === undefined) break;
      a[i] = asv;
      a[s] = ai;
      i = s;
    }
  }
}

/** Streaming line reader over a run file — bounded memory, one partial line held. */
/**
 * Reads a run file back one record at a time, in bounded memory.
 *
 * Exported because the sort is not the only thing that writes a file of records
 * and needs it back: the uniq repair keeps the tuples it has already computed
 * rather than computing them again.
 */
export class RunReader {
  private readonly fd: number;
  private readonly buffer = Buffer.allocUnsafe(READ_BUFFER);
  private pending = '';
  private eof = false;

  constructor(path: string) {
    this.fd = openSync(path, 'r');
  }

  /** Next record, or undefined at end of file. */
  next(): string | undefined {
    for (;;) {
      const nl = this.pending.indexOf('\n');
      if (nl >= 0) {
        const line = this.pending.slice(0, nl);
        this.pending = this.pending.slice(nl + 1);
        return line;
      }
      if (this.eof) {
        if (this.pending.length > 0) {
          const rest = this.pending;
          this.pending = '';
          return rest;
        }
        return undefined;
      }
      const read = readSync(this.fd, this.buffer, 0, this.buffer.length, null);
      if (read === 0) this.eof = true;
      else this.pending += this.buffer.toString('utf8', 0, read);
    }
  }

  close(): void {
    closeSync(this.fd);
  }
}

const byteCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Writes records to a file one at a time, buffered.
 *
 * `writeRun` below takes an array it already holds; this one is for a caller
 * that has a stream and does not want to hold it.
 */
export class RunWriter {
  private readonly fd: number;
  private buffer = '';

  constructor(path: string) {
    this.fd = openSync(path, 'w');
  }

  write(record: string): void {
    this.buffer += record;
    this.buffer += '\n';
    if (this.buffer.length >= WRITE_BATCH) {
      writeSync(this.fd, this.buffer);
      this.buffer = '';
    }
  }

  close(): void {
    if (this.buffer.length > 0) writeSync(this.fd, this.buffer);
    this.buffer = '';
    closeSync(this.fd);
  }
}

function writeRun(records: readonly string[], path: string): void {
  const fd = openSync(path, 'w');
  try {
    let buf = '';
    for (const r of records) {
      buf += r;
      buf += '\n';
      if (buf.length >= WRITE_BATCH) {
        writeSync(fd, buf);
        buf = '';
      }
    }
    if (buf.length > 0) writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

/**
 * Sort `records` into a fully-ordered stream using bounded memory. Yields the
 * sorted records. Consume the whole generator (temp files are cleaned up when
 * it finishes or is returned early).
 */
export function* externalSort(
  records: Iterable<string>,
  options: ExternalSortOptions = {},
): Generator<string, void, void> {
  const compare = options.compare ?? byteCompare;
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK);
  const runs: string[] = [];
  let dir: string | undefined;
  let chunk: string[] = [];

  const flushChunk = (): void => {
    chunk.sort(compare);
    dir ??= mkdtempSync(join(options.tmpDir ?? tmpdir(), 'tdc-esort-'));
    const path = join(dir, `run-${String(runs.length)}.txt`);
    writeRun(chunk, path);
    runs.push(path);
    chunk = [];
  };

  for (const r of records) {
    chunk.push(r);
    if (chunk.length >= chunkSize) flushChunk();
  }

  try {
    // Everything fit in one chunk → sort in RAM, never touch disk.
    if (runs.length === 0) {
      chunk.sort(compare);
      yield* chunk;
      return;
    }
    if (chunk.length > 0) flushChunk();

    // K-way merge the sorted runs.
    const readers = runs.map((p) => new RunReader(p));
    const heap = new MinHeap<{ readonly value: string; readonly run: number }>(
      (x, y) => compare(x.value, y.value) || x.run - y.run,
    );
    readers.forEach((reader, run) => {
      const value = reader.next();
      if (value !== undefined) heap.push({ value, run });
    });
    while (heap.size > 0) {
      const top = heap.pop();
      yield top.value;
      const reader = readers[top.run];
      const value = reader?.next();
      if (value !== undefined) heap.push({ value, run: top.run });
    }
    for (const reader of readers) reader.close();
  } finally {
    if (dir !== undefined)
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
