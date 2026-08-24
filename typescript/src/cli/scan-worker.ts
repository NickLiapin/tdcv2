/**
 * Worker thread for the uniq scan (`--jobs N`) — fingerprints.
 *
 * Before a uniq run can write anything it has to find out which rows collided.
 * That means computing every row's tuple, and it splits because a tuple is a
 * function of its own row number: a worker takes a contiguous range, hashes
 * each tuple into a 13-byte fingerprint, and routes it straight into the file
 * of the pile the hash names. Nothing is sorted here — a pile is sorted by the
 * pile worker that picks it up, so that half of the work is spread too.
 *
 * The registry here is built WITHOUT applying the uniq group. That is not a
 * shortcut: the scan's input is what each row drew BEFORE any rearrangement,
 * so applying the rearrangement to obtain it would be circular.
 *
 * The same worker also answers the VERIFY step: given row numbers whose
 * fingerprints matched, it returns their true tuples, so the coordinator can
 * tell genuine repeats from hash collisions. Both jobs need the registry,
 * which is why they share a worker.
 */

import { mkdirSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { bundledPacksDir, scanPacks } from '../data-pack/load.js';
import { parseStrict } from '../parser/index.js';
import { prepareRender } from '../processor/render.js';
import { tupleKeyAt, writeFingerprintPiles } from '../sequence/exact-uniq.js';
import { sequenceValueAt } from '../sequence/index.js';

import type { UniqResolver } from '../sequence/exact-uniq.js';

export interface ScanWorkerInput {
  readonly source: string;
  readonly seed: string;
  readonly count: number;
  readonly locale?: string | undefined;
  readonly defaultLocale?: string | undefined;
  readonly now: number;
  readonly dataPaths?: readonly string[] | undefined;
  readonly baseDir?: string | undefined;
  /** The group's members, in the order the engine reads them. */
  readonly members: readonly string[];
  /** Scan job: hash rows `[start, end)` into pile files. */
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  /** Directory the pile files go in — the coordinator's, and its to remove. */
  readonly dir?: string | undefined;
  /** Distinguishes this worker's files from the others' in that directory. */
  readonly prefix?: string | undefined;
  /** How many piles — the same number every worker was given. */
  readonly buckets?: number | undefined;
  /**
   * Verify job instead: return `[row, tuple]` for each of these rows. Sent for
   * the rows whose fingerprints matched — a handful, so one worker does it.
   */
  readonly verifyIndices?: readonly number[] | undefined;
}

function buildResolvers(input: ScanWorkerInput): readonly UniqResolver[] {
  const document = parseStrict(input.source);
  const roots = [bundledPacksDir(), ...(input.dataPaths ?? [])].filter(
    (p): p is string => p !== undefined,
  );
  const prepared = prepareRender(document, {
    seed: input.seed,
    count: input.count,
    ...(input.locale !== undefined ? { locale: input.locale } : {}),
    ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : {}),
    packs: scanPacks(roots).registry,
    now: input.now,
    mode: 'disk',
    skipEnvUniq: true,
    dataPaths: input.dataPaths,
    baseDir: input.baseDir,
    source: input.source,
  });
  return input.members.map((name) => {
    const sequence = prepared.registry[name];
    return {
      id: name,
      resolve: (i: number): string => (sequence ? (sequenceValueAt(sequence, i) ?? '') : ''),
    };
  });
}

function run(input: ScanWorkerInput): { paths?: readonly string[]; pairs?: [number, string][] } {
  const resolvers = buildResolvers(input);
  if (input.verifyIndices !== undefined) {
    return { pairs: input.verifyIndices.map((row) => [row, tupleKeyAt(resolvers, row)]) };
  }
  if (input.dir === undefined || input.prefix === undefined) {
    throw new Error('scan worker needs either verifyIndices or a range with dir and prefix');
  }
  mkdirSync(input.dir, { recursive: true });
  return {
    paths: writeFingerprintPiles(
      resolvers,
      input.start ?? 0,
      input.end ?? 0,
      input.dir,
      input.prefix,
      input.buckets ?? 1,
      // The rows this worker has hashed, for the coordinator to add up. On a
      // large uniq run the scan is the longest phase, so it is the one a
      // watcher most needs to see moving.
      (report) => {
        parentPort?.postMessage({ rows: report.done });
      },
    ),
  };
}

// Entry: do the assigned job, then report the result (or the failure).
try {
  parentPort?.postMessage({ ok: true, ...run(workerData as ScanWorkerInput) });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
