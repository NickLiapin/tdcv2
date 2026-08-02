/**
 * Parallel Parquet generation (`--jobs N`).
 *
 * The text coordinator splits rows; this one splits ROW GROUPS. That is the
 * whole trick: a group's bytes are position-independent (page headers carry
 * sizes, and every offset in the format lives in the footer), so workers can
 * build whole groups on their own and the coordinator only has to lay them end
 * to end, shift the recorded offsets, and write one footer.
 *
 * Splitting on a group boundary rather than an arbitrary row is what keeps the
 * output byte-identical to a single-threaded run: cut mid-group and the file
 * would contain groups a `--jobs 1` run never produces.
 *
 * Measured motivation: a 1M-row config spends ~7s of CPU but only ~1.1 cores,
 * because Parquet was excluded from `--jobs`. The same work spread over the
 * cores the text path already uses brings the wall clock down accordingly.
 */

import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { writeAllSync } from '../output/write-all.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  parquetFooter,
  PARQUET_MAGIC,
  shiftChunks,
  type GroupMeta,
  type ParquetSchemaColumn,
} from '../output/parquet/writer.js';
import { parquetRowGroupCount, parquetSchemaOf } from '../output/render-parquet.js';
import { parseStrict } from '../parser/index.js';

import type { ParquetWorkerGroup, ParquetWorkerInput } from './parquet-worker.js';

const WORKER_PATH = fileURLToPath(new URL('./parquet-worker.js', import.meta.url));
const CONCAT_BUFFER_BYTES = 1 << 20;

export interface ParquetParallelParams {
  readonly source: string;
  readonly seed: string;
  readonly count: number;
  readonly locale: string | undefined;
  readonly now: number;
  readonly dataPaths?: readonly string[] | undefined;
  readonly baseDir?: string | undefined;
  readonly jobs: number;
  readonly destFd: number;
}

/** Contiguous, balanced group ranges covering `[0, groups)`. */
export function partitionGroups(
  groups: number,
  jobs: number,
): readonly (readonly [number, number])[] {
  const j = Math.max(1, Math.min(jobs, Math.max(1, groups)));
  const base = Math.floor(groups / j);
  const remainder = groups % j;
  const ranges: [number, number][] = [];
  let start = 0;
  for (let k = 0; k < j; k++) {
    const end = start + base + (k < remainder ? 1 : 0);
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

/**
 * How many workers a Parquet run can actually use. Never more than there are
 * row groups — a worker with no groups would only cost a thread.
 */
export function parquetJobLimit(source: string, jobs: number, now: number, seed: string): number {
  const groups = parquetRowGroupCount(parseStrict(source), { now, seed });
  return Math.max(1, Math.min(jobs, groups));
}

/** Generate to `destFd` across worker threads. */
export async function runParquetParallel(params: ParquetParallelParams): Promise<void> {
  const document = parseStrict(params.source);
  const schema: readonly ParquetSchemaColumn[] = parquetSchemaOf(document, {
    seed: params.seed,
    count: params.count,
    now: params.now,
    stream: true,
    dataPaths: params.dataPaths,
    baseDir: params.baseDir,
    source: params.source,
    ...(params.locale === undefined ? {} : { locale: params.locale }),
  });
  const totalGroups = parquetRowGroupCount(document, {
    seed: params.seed,
    count: params.count,
    now: params.now,
  });
  const ranges = partitionGroups(totalGroups, params.jobs);

  const dir = mkdtempSync(join(tmpdir(), 'tdc-parquet-'));
  const tmpPaths = ranges.map((_, k) => join(dir, `group-${String(k)}.bin`));

  try {
    const results = await Promise.all(
      ranges.map(([startGroup, endGroup], k) =>
        runWorker({
          source: params.source,
          seed: params.seed,
          count: params.count,
          locale: params.locale ?? 'en',
          now: params.now,
          dataPaths: params.dataPaths,
          baseDir: params.baseDir,
          startGroup,
          endGroup,
          tmpPath: tmpPaths[k] ?? join(dir, `group-${String(k)}.bin`),
        }),
      ),
    );

    writeAllSync(params.destFd, PARQUET_MAGIC);
    let offset = PARQUET_MAGIC.length;
    const groups: GroupMeta[] = [];
    let numRows = 0;

    // In order: the groups must land in the same sequence a single-threaded
    // run would have produced, or the rows come out shuffled.
    const buffer = Buffer.allocUnsafe(CONCAT_BUFFER_BYTES);
    for (const [k, result] of results.entries()) {
      for (const group of result.groups) {
        groups.push({ chunks: shiftChunks(group.chunks, offset), numRows: group.numRows });
        offset += group.byteLength;
        numRows += group.numRows;
      }
      concatFileToFd(tmpPaths[k] ?? '', params.destFd, buffer);
    }

    writeAllSync(params.destFd, parquetFooter(schema, groups, numRows));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

interface WorkerReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly groups?: ParquetWorkerGroup[];
}

function runWorker(input: ParquetWorkerInput): Promise<{ groups: ParquetWorkerGroup[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: input });
    let reply: WorkerReply | undefined;
    let earlyError: Error | undefined;
    worker.on('message', (msg: WorkerReply) => {
      reply = msg;
    });
    worker.on('error', (err: Error) => {
      earlyError = err;
    });
    worker.on('exit', () => {
      if (earlyError) {
        reject(earlyError);
        return;
      }
      if (!reply?.ok) {
        reject(new Error(reply?.error ?? 'parquet worker failed'));
        return;
      }
      resolve({ groups: reply.groups ?? [] });
    });
  });
}

function concatFileToFd(path: string, destFd: number, buffer: Buffer): void {
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      writeAllSync(destFd, buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
}
