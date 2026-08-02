/**
 * Worker thread for parallel Parquet generation.
 *
 * A row group's BYTES do not depend on where it sits in the file: page headers
 * carry sizes, and the only offsets in the format live in the footer. So a
 * worker can build whole groups on its own and hand back both the bytes and
 * the metadata, leaving the coordinator to concatenate and fix the offsets.
 *
 * The split is by GROUP, never by an arbitrary row count. Cutting mid-group
 * would produce groups a single-threaded run never makes, and the two outputs
 * would stop matching — which is the property `--jobs` is supposed to preserve.
 */

import { closeSync, openSync, writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

import { renderParquetBlocks, ROW_GROUP_ROWS } from '../output/render-parquet.js';
import type { ChunkMeta } from '../output/parquet/writer.js';
import { parseStrict } from '../parser/index.js';

export interface ParquetWorkerInput {
  readonly source: string;
  readonly seed: string;
  readonly count: number;
  readonly locale: string;
  readonly now: number;
  readonly dataPaths?: readonly string[] | undefined;
  readonly baseDir?: string | undefined;
  /** Row-group indices `[startGroup, endGroup)` this worker owns. */
  readonly startGroup: number;
  readonly endGroup: number;
  readonly tmpPath: string;
}

/** What the coordinator needs to place this worker's output and describe it. */
export interface ParquetWorkerGroup {
  readonly chunks: ChunkMeta[];
  readonly numRows: number;
  readonly byteLength: number;
}

export interface ParquetWorkerResult {
  readonly ok: true;
  readonly groups: ParquetWorkerGroup[];
  /** Total bytes written to the temp file. */
  readonly byteLength: number;
}

function run(input: ParquetWorkerInput): ParquetWorkerResult {
  const document = parseStrict(input.source);
  const fd = openSync(input.tmpPath, 'w');
  const groups: ParquetWorkerGroup[] = [];
  let byteLength = 0;
  try {
    for (const block of renderParquetBlocks(
      document,
      {
        seed: input.seed,
        count: input.count,
        locale: input.locale,
        now: input.now,
        stream: true,
        dataPaths: input.dataPaths,
        baseDir: input.baseDir,
        source: input.source,
      },
      { from: input.startGroup * ROW_GROUP_ROWS, to: input.endGroup * ROW_GROUP_ROWS },
    )) {
      for (const page of block.pages) writeSync(fd, page);
      groups.push({
        chunks: block.chunks,
        numRows: block.numRows,
        byteLength: block.byteLength,
      });
      byteLength += block.byteLength;
    }
  } finally {
    closeSync(fd);
  }
  return { ok: true, groups, byteLength };
}

try {
  parentPort?.postMessage(run(workerData as ParquetWorkerInput));
} catch (err) {
  parentPort?.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
