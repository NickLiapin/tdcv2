/**
 * Worker thread for the uniq SCAN (`--jobs N`).
 *
 * Before a uniq run can write anything it has to find out which rows collided,
 * and that means computing every row's tuple and sorting them so equal ones
 * become adjacent. On a 97,000,000-row config that pass was 23 minutes of a
 * 61-minute run, on one core out of twelve.
 *
 * It splits because each row's tuple is a function of its own number and
 * nothing else. A worker takes a contiguous range, computes exactly the records
 * the whole-file scan would produce there, sorts them into run files, and
 * reports the paths. The coordinator merges everyone's runs — cheap, since
 * nothing is computed and nothing is sorted again, only read in order.
 *
 * The registry here is built WITHOUT applying the uniq group. That is not a
 * shortcut: the scan's input is what each row drew BEFORE any rearrangement, so
 * applying the rearrangement to obtain it would be circular.
 */

import { mkdirSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { bundledPacksDir, scanPacks } from '../data-pack/load.js';
import { parseStrict } from '../parser/index.js';
import { prepareRender } from '../processor/render.js';
import { scanTupleRuns } from '../sequence/exact-uniq.js';
import { sequenceValueAt } from '../sequence/index.js';

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
  readonly start: number;
  readonly end: number;
  /** Directory the run files go in — the coordinator's, and its to remove. */
  readonly dir: string;
  /** Distinguishes this worker's files from the others' in that directory. */
  readonly prefix: string;
}

function run(input: ScanWorkerInput): readonly string[] {
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

  const resolvers = input.members.map((name) => {
    const sequence = prepared.registry[name];
    return {
      id: name,
      resolve: (i: number): string => (sequence ? (sequenceValueAt(sequence, i) ?? '') : ''),
    };
  });

  mkdirSync(input.dir, { recursive: true });
  return scanTupleRuns(resolvers, input.start, input.end, input.dir, input.prefix);
}

// Entry: scan the assigned range, then report the files (or the failure).
try {
  const paths = run(workerData as ScanWorkerInput);
  parentPort?.postMessage({ ok: true, paths });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
