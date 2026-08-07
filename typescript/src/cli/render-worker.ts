/**
 * Worker thread for parallel generation (`--jobs N`).
 *
 * Each worker renders ONE contiguous row range to its own temp file. Because
 * Engine 2's value(i) is seekable (independent per row), a worker needs no
 * coordination with the others — it re-parses the source, renders
 * `[start, end)` with the SAME options as the single-threaded run, and writes
 * the bytes. The coordinator concatenates the temp files in order, reproducing
 * the single-threaded output byte-for-byte.
 */

import { closeSync, openSync, writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { bundledPacksDir, scanPacks } from '../data-pack/load.js';
import { parseStrict } from '../parser/index.js';
import { renderStream } from '../processor/render.js';

import { WRITE_BATCH_BYTES } from '../lib/tdc.js';

export interface RenderWorkerInput {
  readonly source: string;
  readonly seed: string;
  readonly count: number;
  /** An override the caller asked for; `undefined` leaves the config's own `local=` alone. */
  readonly locale?: string | undefined;
  /** The project config's locale — a fallback, never an override. */
  readonly defaultLocale?: string | undefined;
  readonly now: number;
  readonly dataPaths?: readonly string[] | undefined;
  readonly baseDir?: string | undefined;
  readonly start: number;
  readonly end: number;
  readonly tmpPath: string;
}

function run(input: RenderWorkerInput): void {
  const document = parseStrict(input.source);
  const fd = openSync(input.tmpPath, 'w');
  try {
    let buf = '';
    // A PackRegistry cannot cross the worker boundary, so the worker rebuilds
    // it from the SAME roots the main thread scanned. Leaving this out let
    // `renderStream` fall back to the bundled packs alone, and every pack the
    // user had installed vanished — silently, and only above the row count at
    // which parallelism turns itself on.
    const roots = [bundledPacksDir(), ...(input.dataPaths ?? [])].filter(
      (p): p is string => p !== undefined,
    );
    for (const chunk of renderStream(document, {
      seed: input.seed,
      count: input.count,
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.defaultLocale !== undefined ? { defaultLocale: input.defaultLocale } : {}),
      packs: scanPacks(roots).registry,
      now: input.now,
      stream: true,
      dataPaths: input.dataPaths,
      baseDir: input.baseDir,
      source: input.source,
      range: { start: input.start, end: input.end },
    })) {
      buf += chunk;
      if (buf.length >= WRITE_BATCH_BYTES) {
        writeSync(fd, buf);
        buf = '';
      }
    }
    if (buf.length > 0) writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

// Entry: run the assigned range, then report success/failure to the coordinator.
try {
  run(workerData as RenderWorkerInput);
  parentPort?.postMessage({ ok: true });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
