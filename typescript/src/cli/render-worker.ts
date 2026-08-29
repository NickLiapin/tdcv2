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
import type { UniqPlan } from '../sequence/build.js';

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
  /** The engine the caller FORCED; undefined routes by config (`mode: "disk"`). */
  readonly engine?: 1 | 2 | 3 | undefined;
  readonly start: number;
  readonly end: number;
  readonly tmpPath: string;
  /**
   * The uniq arrangement the coordinator worked out for the WHOLE file.
   *
   * Without it a worker would analyse the run itself — every row, twice — and
   * eleven workers each doing that is slower than one thread doing it once.
   * With it a worker does no analysis at all and simply renders its range.
   */
  readonly uniqPlan?: UniqPlan | undefined;
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
      /*
       * Route as the whole-file run routes, rather than forcing Engine 2.
       *
       * The engine is a function of the config, so `disk` lands the worker on
       * the same one the coordinator resolved — Engine 2 normally, Engine 3
       * when the config needs exact percentages and uniqueness together.
       * Forcing Engine 2 here meant every Engine 3 config was refused
       * parallelism outright, and those are the large ones.
       *
       * A caller-FORCED engine overrides the routing: a worker that renders
       * `--engine 3` under `mode: "disk"` inherits disk mode's silent
       * in-memory fallback, which is the substitution a named engine exists
       * to refuse.
       */
      ...(input.engine !== undefined ? { engine: input.engine } : { mode: 'disk' as const }),
      ...(input.uniqPlan !== undefined ? { uniqPlan: input.uniqPlan } : {}),
      dataPaths: input.dataPaths,
      baseDir: input.baseDir,
      source: input.source,
      range: { start: input.start, end: input.end },
      /*
       * The rows this worker has finished, sent to the coordinator as it goes.
       *
       * Without it a parallel run says nothing at all until it is over — and a
       * parallel run is what the CLI chooses by itself above a hundred thousand
       * rows, so that was the silent case rather than the rare one. The
       * coordinator adds up what every worker reports; a message carrying
       * `rows` is progress, one carrying `ok` is the result.
       */
      onProgress: (report) => {
        if (report.phase === 'render') parentPort?.postMessage({ rows: report.done });
      },
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
