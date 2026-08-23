/**
 * The fingerprint carrier, tested on its own terms.
 *
 * Everything above it — Engine 5's scan, verification, repair — leans on four
 * properties: records survive the file byte for byte, sorting orders them the
 * way the search expects, candidate grouping loses no repeated fingerprint,
 * and the ledger never answers "free" about a taken tuple. Each is pinned
 * here, and the poison runs in the suite's history: breaking the comparator's
 * low word made the sort test fail, and dropping the moving-set check made the
 * ledger test fail.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  candidateGroups,
  FingerprintLedger,
  FingerprintReader,
  FingerprintWriter,
  fingerprintBucket,
  hash64,
  MAX_INDEX,
  sortFingerprintFiles,
} from '../../src/sequence/fingerprint.js';
import { bucketOf } from '../../src/sequence/bucket-uniq.js';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdc-fp-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('fingerprint records', () => {
  it('round-trip the file exactly, including indexes past 32 bits', () => {
    const path = join(dir, 'roundtrip');
    const rows: [number, number, number][] = [
      [0, 0, 0],
      [0xffffffff, 0xffffffff, MAX_INDEX - 1],
      [123456789, 987654321, 5_000_000_000], // above 2^32: the fifth byte matters
      [1, 2, 3],
    ];
    const writer = new FingerprintWriter(path);
    for (const [hi, lo, index] of rows) writer.write(hi, lo, index);
    writer.close();

    const reader = new FingerprintReader(path);
    const back: [number, number, number][] = [];
    while (reader.next()) back.push([reader.hi, reader.lo, reader.index]);
    reader.close();
    expect(back).toEqual(rows);
  });

  it('refuses an index the record cannot carry, rather than wrapping it', () => {
    const writer = new FingerprintWriter(join(dir, 'overflow'));
    try {
      expect(() => {
        writer.write(1, 1, MAX_INDEX);
      }).toThrow(/5-byte/);
    } finally {
      writer.close();
    }
  });

  it('routes to the same pile as the text carrier, so the two engines agree', () => {
    // Engine 4 buckets the tuple TEXT with cyrb128's first word; the
    // fingerprint IS that word. If these ever diverged, a tuple would sit in
    // one pile as text and another as a fingerprint.
    for (const key of ['MaleIvanPetrov', 'a', 'ключ с юникодом', '']) {
      for (const buckets of [2, 7, 44, 256]) {
        expect(fingerprintBucket(hash64(key).hi, buckets)).toBe(bucketOf(key, buckets));
      }
    }
  });
});

describe('sorting and candidates', () => {
  it('sorts many files into one ordered stream and finds every repeated fingerprint', () => {
    /*
     * Three input files, written unsorted, with planted duplicates that span
     * files — the shape the scan threads actually produce. Tiny batch size so
     * the EXTERNAL path (runs + merge) is what runs, not the single-batch
     * shortcut.
     */
    const inputs = [join(dir, 'in-0'), join(dir, 'in-1'), join(dir, 'in-2')];
    const planted: Record<string, number[]> = {
      dupA: [7, 105, 203],
      dupB: [50, 151],
    };
    const writers = inputs.map((p) => new FingerprintWriter(p));
    let n = 0;
    for (let i = 0; i < 300; i++) {
      const w = writers[i % 3];
      if (!w) continue;
      const { hi, lo } = hash64(`unique-${String(i)}`);
      w.write(hi, lo, n++);
    }
    Object.entries(planted).forEach(([key, rows], k) => {
      const { hi, lo } = hash64(key);
      for (const row of rows) writers[k % 3]?.write(hi, lo, row);
    });
    /*
     * Records that share the HIGH word and differ only in the low one, written
     * in descending low order. A sort that compares only the high word leaves
     * these unordered — and passed this suite once, because 305 random hashes
     * never collide in 32 bits. The low word has to decide somewhere for the
     * test to be able to fail.
     */
    for (let lo = 9; lo >= 0; lo--) writers[0]?.write(777, lo, 400 + lo);
    for (const w of writers) w.close();

    const sorted = join(dir, 'sorted');
    const total = sortFingerprintFiles(inputs, sorted, dir, 64); // 64-record batches → many runs
    expect(total).toBe(300 + 5 + 10);

    // The stream is genuinely ordered…
    const reader = new FingerprintReader(sorted);
    let prevHi = -1;
    let prevLo = -1;
    let seen = 0;
    while (reader.next()) {
      const ok = reader.hi > prevHi || (reader.hi === prevHi && reader.lo >= prevLo);
      if (!ok) throw new Error(`беспорядок на записи ${String(seen)}`);
      prevHi = reader.hi;
      prevLo = reader.lo;
      seen++;
    }
    reader.close();
    expect(seen).toBe(315);

    // …and the candidate groups are exactly the planted ones, rows ascending.
    const groups = [...candidateGroups(sorted)].map((g) => [...g].sort((a, b) => a - b));
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual([7, 105, 203]);
    expect(groups).toContainEqual([50, 151]);
  });
});

describe('the ledger', () => {
  it('never says "free" about a taken tuple, and honors the moving set', () => {
    const buckets = 4;
    const keys = Array.from({ length: 500 }, (_, i) => `taken-${String(i)}`);

    // Route into piles exactly as the engine does, sort each pile.
    const pilePaths: string[] = [];
    const rawWriters = Array.from({ length: buckets }, (_, b) => {
      const p = join(dir, `pile-raw-${String(b)}`);
      return new FingerprintWriter(p);
    });
    keys.forEach((key, row) => {
      const { hi, lo } = hash64(key);
      rawWriters[fingerprintBucket(hi, buckets)]?.write(hi, lo, row);
    });
    rawWriters.forEach((w, b) => {
      w.close();
      const sorted = join(dir, `pile-sorted-${String(b)}`);
      sortFingerprintFiles([join(dir, `pile-raw-${String(b)}`)], sorted, dir);
      pilePaths.push(sorted);
    });

    const moving = new Set([3, 4]);
    const ledger = new FingerprintLedger(pilePaths, moving);
    try {
      // Every taken tuple answers taken — the property uniqueness rests on.
      keys.forEach((key, row) => {
        if (!moving.has(row)) expect(ledger.has(key)).toBe(true);
      });
      // A tuple held ONLY by rows being moved is free: their old values are
      // exactly what the repair is giving away.
      expect(ledger.has('taken-3')).toBe(false);
      expect(ledger.has('taken-4')).toBe(false);
      // Tuples nobody holds are free (no false positives at this size).
      for (let i = 0; i < 200; i++) expect(ledger.has(`nobody-${String(i)}`)).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
