/**
 * Worker thread for one pile of tuples — Engine 4.
 *
 * The smallest worker here, and deliberately so. A pile is a set of records
 * chosen by a hash of the tuple, which means every copy of a repeated tuple is
 * in the same pile and no pile ever has to be compared with another. Finding
 * the repeats inside one is therefore pure file work: sort the records, walk
 * them, report the row numbers that have to move.
 *
 * It needs no config, no data packs, no registry, no seed — nothing but the
 * files. That is what makes the piles cheap to spread: the coordinator hands
 * over paths and gets back numbers.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { excessFromRecords } from '../sequence/exact-uniq.js';
import { RunReader } from '../sequence/external-sort.js';

export interface PileWorkerInput {
  /** Every file holding part of this pile — one per thread that wrote into it. */
  readonly paths: readonly string[];
  /** Records held in RAM per sort run. */
  readonly chunkSize?: number | undefined;
  /** Where the sort may put its own temp files. */
  readonly tmpDir?: string | undefined;
}

function run(input: PileWorkerInput): readonly number[] {
  const records = function* (): Generator<string> {
    for (const path of input.paths) {
      const reader = new RunReader(path);
      try {
        for (let r = reader.next(); r !== undefined; r = reader.next()) yield r;
      } finally {
        reader.close();
      }
    }
  };
  return excessFromRecords(records(), {
    ...(input.chunkSize !== undefined ? { chunkSize: input.chunkSize } : {}),
    ...(input.tmpDir !== undefined ? { tmpDir: input.tmpDir } : {}),
  });
}

try {
  const excess = run(workerData as PileWorkerInput);
  parentPort?.postMessage({ ok: true, excess });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
