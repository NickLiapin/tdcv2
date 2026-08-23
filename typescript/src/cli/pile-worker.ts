/**
 * Worker thread for one pile of fingerprints.
 *
 * The smallest worker here, deliberately: a pile is a set of 13-byte records
 * chosen by a hash of the tuple, so every copy of a repeated tuple is in the
 * same pile and no pile ever has to be compared with another. This worker
 * sorts its pile's files into one ordered file and reports the row groups
 * whose fingerprints match — CANDIDATES, which the coordinator verifies
 * against the true tuples before believing them.
 *
 * It needs no config, no data packs, no registry, no seed — only the files.
 * That is what makes the piles cheap to spread: the coordinator hands over
 * paths and gets back row numbers.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { candidateGroups, sortFingerprintFiles } from '../sequence/fingerprint.js';

export interface PileWorkerInput {
  /** Every file holding part of this pile — one per thread that wrote into it. */
  readonly paths: readonly string[];
  /** Where the sorted pile goes. Kept: the repair binary-searches it later. */
  readonly outPath: string;
  /** Where the sort may put its own temp files. */
  readonly tmpDir?: string | undefined;
}

function run(input: PileWorkerInput): (readonly number[])[] {
  sortFingerprintFiles(input.paths, input.outPath, input.tmpDir);
  return [...candidateGroups(input.outPath)];
}

try {
  parentPort?.postMessage({ ok: true, candidates: run(workerData as PileWorkerInput) });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
