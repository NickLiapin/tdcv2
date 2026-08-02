/**
 * Fit the run into the machine's memory by choosing fewer workers.
 *
 * Every worker is a separate V8 isolate that re-reads and re-parses the config's
 * data files, so memory grows LINEARLY with the job count. Measured on a
 * 160 000-row surname CSV: 170 MB at one worker, 1057 MB at eight — while the
 * wall clock stayed at 0.6 s either way. Paying six times the memory for no
 * time at all is the worst kind of default.
 *
 * The decision is made silently. Someone generating test data may be an
 * analyst rather than an engineer, and telling them about isolates, cores and
 * heap growth helps nobody; the tool should simply not put itself in a position
 * where it dies halfway. Slower and finished beats faster and killed.
 *
 * Note that switching ENGINE does not help here. A large value list has to be
 * resident whatever the engine does with rows — measured at 172 MB for stream,
 * disk and memory alike. The only lever for list size is the worker count.
 */

import { statSync } from 'node:fs';
import { totalmem } from 'node:os';

import { resolveExistingDataSourcePath, type DataSourceOptions } from '../data-source/index.js';

/**
 * Resident cost of one worker before any data: a fresh isolate plus the loaded
 * packs and engine. Measured at ~107 MB; rounded up because a too-low guess is
 * the dangerous direction.
 */
const BYTES_PER_WORKER_BASE = 120 * 1024 * 1024;

/**
 * How much a byte of CSV on disk costs once parsed into JS strings and arrays.
 * Measured across three file sizes at ~46-52x; 50 is the working figure.
 */
const PARSED_INFLATION = 50;

/**
 * Share of physical RAM a generation run may plan to occupy. The rest is the
 * OS, the user's editor, and the browser they left open.
 */
const SAFE_SHARE = 0.5;

/** Total on-disk size of every `src=` file the config reads. */
export function dataFileBytes(sources: readonly string[], options: DataSourceOptions = {}): number {
  let total = 0;
  for (const src of sources) {
    try {
      total += statSync(resolveExistingDataSourcePath(src, options).path).size;
    } catch {
      // Unreadable or missing: the validator reports it properly. Nothing to
      // budget for, and this must never be the thing that fails a run.
    }
  }
  return total;
}

/** Every `src="…"` in the source, in document order. Cheap textual scan. */
export function declaredSources(source: string): string[] {
  const out: string[] = [];
  const pattern = /\bsrc\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const value = (match[1] ?? '').trim();
    if (value !== '') out.push(value);
  }
  return out;
}

export interface JobBudget {
  /** Workers the machine can actually afford. */
  readonly jobs: number;
  /** True when the request was reduced — the caller may mention it if asked explicitly. */
  readonly reduced: boolean;
}

/**
 * Reduce a job count until the run fits in memory.
 *
 * Never returns 0: one worker always runs, because refusing outright would be
 * less useful than being slow. If even one worker looks too large, that is a
 * problem no job count can fix and the engine choice already handles the row
 * side of it.
 */
export function fitJobsToMemory(params: {
  readonly jobs: number;
  readonly dataBytes: number;
  readonly totalBytes?: number;
}): JobBudget {
  const total = params.totalBytes ?? totalmem();
  if (params.jobs <= 1 || total <= 0) return { jobs: Math.max(1, params.jobs), reduced: false };

  const perWorker = BYTES_PER_WORKER_BASE + params.dataBytes * PARSED_INFLATION;
  const affordable = Math.floor((total * SAFE_SHARE) / perWorker);
  const jobs = Math.max(1, Math.min(params.jobs, affordable));
  return { jobs, reduced: jobs < params.jobs };
}
