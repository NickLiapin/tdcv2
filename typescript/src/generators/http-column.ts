/**
 * One `<gen type="http">` as a column of the run, fetched batch by batch.
 *
 * The rule `http` runs on: the column is cut into batches of `batch=` rows,
 * numbered by the ABSOLUTE row of the run — batch k is rows [k·N, (k+1)·N).
 * Wherever the generator sits — a sequence of its own, a `parent=` child, a
 * `<mix>` case, a field — row i reads answer i, and the service is asked only
 * for the batches somebody reads.
 *
 * Both engines use the same object. The in-memory engine asks for a whole
 * column of rows at once; the streaming engine asks for one row at a time, in
 * order, and finds the batch already fetched or on the wire. Memory holds a few
 * batches, never the column.
 *
 * `parallel=` is how many batches may be on the wire together. The default, 1,
 * still overlaps the network with the engine's own work: the next batch is
 * requested the moment the current one arrives, while its rows are written.
 */

import { resolveHttpSecret } from './http-secret.js';
import type { SyncHttpTransport } from './http-transport.js';
import {
  HttpServiceError,
  buildHttpRequest,
  httpSeedFor,
  interpretHttpResult,
  type OnError,
} from './http.js';

/** Everything one http generator needs, resolved once per run. */
export interface HttpColumnSpec {
  /** The column as the reader wrote it — `Hash`, or `Pay.ref` for a field. For messages. */
  readonly sequence: string;
  readonly src: string;
  /** The `in=` column, when the service transforms one. */
  readonly inName?: string | undefined;
  /** The derived `X-TDC-Seed`. */
  readonly seed: string;
  readonly secret?: string | undefined;
  readonly onError: OnError;
  readonly timeoutMs: number;
  /** Rows per request. */
  readonly batch: number;
  /** Batches allowed on the wire at once. */
  readonly parallel: number;
}

/** Rows `[start, end)` of the run. */
export interface RowSpan {
  readonly start: number;
  readonly end: number;
}

/** A batch on the wire: its ticket and the request it answers. */
interface InFlight {
  readonly ticket: number;
  readonly offset: number;
  readonly count: number;
  readonly inputs: readonly string[] | undefined;
}

export class HttpColumn {
  private readonly batches: number;
  private readonly inFlight = new Map<number, InFlight>();
  /** Answered batches, oldest first; trimmed to {@link keep}. */
  private readonly answered = new Map<number, readonly string[]>();
  private readonly keep: number;

  public constructor(
    private readonly spec: HttpColumnSpec,
    /** Rows in the whole run — `X-TDC-Total`. */
    private readonly total: number,
    /** The `in=` column's value at an absolute row. */
    private readonly inputAt: (row: number) => string,
    private readonly transport: SyncHttpTransport,
    /** The rows this process writes, under `--jobs`; the whole run otherwise. */
    private readonly range?: RowSpan | undefined,
  ) {
    this.batches = Math.ceil(total / spec.batch);
    // The batch being read, the one before it (a reader may look one row back
    // across the seam) and everything already on the wire.
    this.keep = spec.parallel + 2;
  }

  /** The answer for one absolute row. */
  public valueAt(row: number): string {
    const k = Math.floor(row / this.spec.batch);
    return this.batch(k, k + 1)[row - k * this.spec.batch] ?? '';
  }

  /**
   * The answers for these absolute rows, in the order given.
   *
   * Only the batches holding them are requested, in ascending order, each
   * exactly once; the next one needed goes on the wire before this one is
   * waited for.
   */
  public valuesAt(rows: readonly number[]): string[] {
    const needed = [...new Set(rows.map((row) => Math.floor(row / this.spec.batch)))].sort(
      (a, b) => a - b,
    );
    const byBatch = new Map<number, readonly string[]>();
    needed.forEach((k, i) => {
      byBatch.set(k, this.batch(k, needed[i + 1], needed.slice(i + 1, i + this.spec.parallel)));
    });
    return rows.map((row) => {
      const k = Math.floor(row / this.spec.batch);
      return byBatch.get(k)?.[row - k * this.spec.batch] ?? '';
    });
  }

  /**
   * Batch `k`, waiting for it if it is not in yet.
   *
   * `next` is the batch that will be wanted after it, put on the wire as soon as
   * `k` arrives so the service works while the engine does. `ahead` is what may
   * go out together with `k` when `parallel` allows more than one.
   */
  private batch(
    k: number,
    next: number | undefined,
    ahead: readonly number[] = this.sequentialAhead(k),
  ): readonly string[] {
    const done = this.answered.get(k);
    if (done !== undefined) return done;
    // The batch being read always goes out — the limit governs what is sent
    // AHEAD, not what the reader is waiting for.
    this.send(k, true);
    for (const j of ahead) this.send(j);
    const flight = this.inFlight.get(k);
    if (flight === undefined) return [];
    this.inFlight.delete(k);
    const values = this.answer(flight);
    this.remember(k, values);
    if (next !== undefined && next < this.batches) this.send(next);
    return values;
  }

  /** For a reader walking forward: the batches after `k` that `parallel` lets out now. */
  private sequentialAhead(k: number): number[] {
    const ahead: number[] = [];
    for (let j = k + 1; j < k + this.spec.parallel && j < this.batches; j++) ahead.push(j);
    return ahead;
  }

  /** Put batch `k` on the wire, unless it is already there or answered. */
  private send(k: number, needed = false): void {
    if (k < 0 || k >= this.batches) return;
    if (this.inFlight.has(k) || this.answered.has(k)) return;
    // Read-ahead stops at this worker's last row: the batch past it belongs to
    // the next worker, and asking for it here would send it twice.
    if (!needed && !this.inRange(k)) return;
    // Never more than `parallel` out at once: a service that is not safe to call
    // concurrently gets exactly one request at a time under the default.
    if (!needed && this.inFlight.size >= this.spec.parallel) return;
    const offset = k * this.spec.batch;
    const count = Math.min(this.spec.batch, this.total - offset);
    const inputs =
      this.spec.inName === undefined
        ? undefined
        : Array.from({ length: count }, (_, i) => this.inputAt(offset + i));
    const ticket = this.transport.start(buildHttpRequest(this.options(offset, count, inputs)));
    this.inFlight.set(k, { ticket, offset, count, inputs });
  }

  private inRange(k: number): boolean {
    if (this.range === undefined) return true;
    const first = k * this.spec.batch;
    return first < this.range.end && first + this.spec.batch > this.range.start;
  }

  /** Wait for a batch and apply the contract, naming the rows when there are several batches. */
  private answer(flight: InFlight): string[] {
    const options = this.options(flight.offset, flight.count, flight.inputs);
    try {
      return interpretHttpResult(options, this.transport.wait(flight.ticket));
    } catch (err) {
      if (err instanceof HttpServiceError) {
        const where =
          this.batches > 1
            ? ` (rows ${String(flight.offset)}–${String(flight.offset + flight.count - 1)})`
            : '';
        throw new Error(
          `http service for sequence "${this.spec.sequence}" at ${err.url}${where} ${err.message}`,
        );
      }
      throw err;
    }
  }

  private options(offset: number, count: number, inputs: readonly string[] | undefined) {
    return {
      src: this.spec.src,
      count,
      offset,
      total: this.total,
      inputs,
      seed: this.spec.seed,
      secret: this.spec.secret,
      onError: this.spec.onError,
      timeoutMs: this.spec.timeoutMs,
    };
  }

  private remember(k: number, values: readonly string[]): void {
    this.answered.set(k, values);
    while (this.answered.size > this.keep) {
      const oldest = this.answered.keys().next().value;
      if (oldest === undefined) break;
      this.answered.delete(oldest);
    }
  }
}

/**
 * Rows per request when `batch=` is absent.
 *
 * Small enough that a reply of long values stays far inside the 64 MB a batch
 * may answer with, and that a streaming run holds little; large enough that the
 * round trip is noise next to the rows it carries. Measured against a local
 * HMAC service, see `temp_docs/PLAN-http-batches.md`.
 */
export const HTTP_DEFAULT_BATCH = 10_000;

/** Seconds a batch may take, when `timeout=` is absent. */
export const HTTP_DEFAULT_TIMEOUT_MS = 30_000;

/** `timeout="30"` → 30_000 ms. The validator refuses anything else; this only defaults. */
export function parseHttpTimeout(raw: string | undefined): number {
  if (raw === undefined) return HTTP_DEFAULT_TIMEOUT_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : HTTP_DEFAULT_TIMEOUT_MS;
}

/** Rows per request for one `<gen type="http">`'s attributes. */
export function httpBatchOf(attrs: Readonly<Record<string, string | undefined>>): number {
  return parseCount(attrs['batch'], HTTP_DEFAULT_BATCH);
}

/** A positive whole number from `batch=`/`parallel=`, or the default. */
function parseCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The attributes of one `<gen type="http">`. */
interface HttpGenLike {
  readonly attrs: Readonly<Record<string, string | undefined>>;
}

/**
 * The http columns of one run.
 *
 * One {@link HttpColumn} per generator and column, made on first use and kept,
 * so the streaming engine — which builds a row at a time — reads the same
 * batches the previous row fetched instead of asking again.
 */
export class HttpSession {
  private readonly columns = new Map<HttpGenLike, Map<string, HttpColumn>>();

  public constructor(
    private readonly envSeed: string,
    private readonly baseDir: string,
    private readonly transport: () => SyncHttpTransport,
    /** The rows this process writes, when a `--jobs` worker writes only some. */
    private readonly range?: RowSpan | undefined,
  ) {}

  /** The column for this generator, as `sequence` reads it. */
  public column(
    gen: HttpGenLike,
    sequence: string,
    total: number,
    inputAt: (row: number) => string,
  ): HttpColumn {
    let bySequence = this.columns.get(gen);
    if (bySequence === undefined) {
      bySequence = new Map();
      this.columns.set(gen, bySequence);
    }
    const known = bySequence.get(sequence);
    if (known !== undefined) return known;
    const made = new HttpColumn(
      this.spec(gen, sequence),
      total,
      inputAt,
      this.transport(),
      this.range,
    );
    bySequence.set(sequence, made);
    return made;
  }

  private spec(gen: HttpGenLike, sequence: string): HttpColumnSpec {
    const attrs = gen.attrs;
    // Resolved per column and never cached: two sequences may sign with two
    // different secrets, and a config that names an unset variable should say so
    // in terms of the sequence the reader wrote.
    const secretSpec = attrs['secret'];
    let secret: string | undefined;
    if (secretSpec !== undefined && secretSpec.trim() !== '') {
      try {
        secret = resolveHttpSecret(secretSpec, this.baseDir);
      } catch (err) {
        throw new Error(
          `http service for sequence "${sequence}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return {
      sequence,
      src: attrs['src'] ?? '',
      inName: attrs['in'],
      seed: httpSeedFor(this.envSeed, sequence),
      secret,
      onError: attrs['on_error'] === 'empty' ? 'empty' : 'fail',
      timeoutMs: parseHttpTimeout(attrs['timeout']),
      batch: httpBatchOf(attrs),
      parallel: parseCount(attrs['parallel'], 1),
    };
  }
}
