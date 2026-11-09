/**
 * The client half of the `http` generator — see
 * docs/specs/2026-07-23-http-service-generator.md §4.
 *
 * Given an endpoint and one batch — where it starts in the column, how many
 * rows, their input values — it POSTs the request and returns exactly `count`
 * values in order. It knows the wire contract and the error model, and nothing
 * about sequences or the engine: `http-column.ts` cuts a column into batches,
 * and the caller wraps a thrown error with the sequence name.
 *
 * Batch, never per-row, and never the whole column at once: one call carries
 * one batch, which keeps a billion rows to a hundred thousand requests rather
 * than a billion, and keeps any one reply small enough to hold.
 */

import { createHmac } from 'node:crypto';

import { cyrb128 } from '../prng/prng.js';

import {
  syncHttpTransport,
  type RawRequest,
  type RawResult,
  type SyncHttpTransport,
} from './http-transport.js';

/** Why a service call failed. The caller turns this into a TDC diagnostic. */
export type HttpFailureKind =
  | 'status' // a non-2xx response (not 429)
  | 'rate-limited' // 429 — always fatal, even under on_error="empty"
  | 'timeout' // no answer within the timeout
  | 'network' // connection refused / DNS / socket error
  | 'count-mismatch' // 2xx, but not exactly `count` lines back
  | 'too-large' // 2xx, but the body outgrew MAX_RESPONSE_BYTES
  | 'offset-ignored'; // a source that did not echo X-TDC-Offset — always fatal

/**
 * The most of ONE reply this client will hold. The contract is one value per
 * line for the rows of one batch — a bounded, known-small answer — so a body
 * that outgrows this is a misbehaving service, and reading it to the end would
 * trade an error message for an OOM. It bounds a batch, never the run: a column
 * of any length is as many batches as it takes. The same limit lives in the
 * other four implementations.
 */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

export class HttpServiceError extends Error {
  public constructor(
    message: string,
    public readonly kind: HttpFailureKind,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpServiceError';
  }
}

export type OnError = 'fail' | 'empty';

export interface HttpFetchOptions {
  readonly src: string;
  /** How many values are wanted — travels as `X-TDC-Count` and bounds the reply. */
  readonly count: number;
  /**
   * The row of the column this batch starts at — travels as `X-TDC-Offset`.
   *
   * A service that invents values from `(seed, row)` needs it: without it every
   * batch would start counting at zero and hand back the first batch again, a
   * column of silent repeats. Default 0.
   */
  readonly offset?: number | undefined;
  /** Rows in the whole column — travels as `X-TDC-Total`. Default `count`. */
  readonly total?: number | undefined;
  /** One line per input value, in row order. Omit/empty for a pure source. */
  readonly inputs?: readonly string[] | undefined;
  /**
   * Travels as `X-TDC-Seed`. Derived per SEQUENCE, not the raw `<env>` seed:
   * two http sequences pointed at one service must not receive the same seed,
   * or a service that generates from it would hand back two identical columns.
   */
  readonly seed?: string | undefined;
  readonly onError: OnError;
  readonly timeoutMs: number;
  /**
   * The already-resolved `secret=`, if the config carries one.
   *
   * Present means the request is SIGNED: `X-TDC-Timestamp` and
   * `X-TDC-Signature` travel with it and the service can tell the generator from
   * anyone else who can reach the port. The secret itself never goes on the
   * wire. Resolution is the caller's job — see `resolveHttpSecret`.
   */
  readonly secret?: string | undefined;
  /**
   * Wall-clock milliseconds stamped into the signature.
   *
   * The REAL clock, not the run's pinned `now`: it exists so a service can
   * refuse a request replayed tomorrow, and a config pinned to last year would
   * be refused by every service that checks. Injectable so a test can pin it.
   */
  readonly nowMs?: number | undefined;
}

/**
 * The headers that say what this request IS, beyond its body.
 *
 * `X-TDC-Input` is the one that closes a real ambiguity: `in=` naming a column
 * of one empty value produced an empty body, which is exactly what a pure
 * source sends, and the service could not tell "process this empty value" from
 * "invent one". It carries the number of input lines, so zero-versus-absent is
 * the whole answer, and a service that ignores it behaves as it always did.
 */
export function contractHeaders(opts: HttpFetchOptions, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    'X-TDC-Count': String(opts.count),
    'X-TDC-Offset': String(offsetOf(opts)),
    'X-TDC-Total': String(totalOf(opts)),
  };
  if (opts.seed !== undefined) headers['X-TDC-Seed'] = opts.seed;
  if (opts.inputs !== undefined) headers['X-TDC-Input'] = String(opts.inputs.length);
  if (opts.secret !== undefined && opts.secret !== '') {
    const timestamp = String(Math.floor((opts.nowMs ?? Date.now()) / 1000));
    headers['X-TDC-Timestamp'] = timestamp;
    headers['X-TDC-Signature'] = signRequest(
      opts.secret,
      timestamp,
      opts.seed ?? '',
      opts.count,
      offsetOf(opts),
      totalOf(opts),
      body,
    );
  }
  return headers;
}

/** Where the batch starts in its column. */
function offsetOf(opts: HttpFetchOptions): number {
  return opts.offset ?? 0;
}

/** How long the whole column is. */
function totalOf(opts: HttpFetchOptions): number {
  return opts.total ?? opts.count;
}

/**
 * `hex(HMAC-SHA256(secret, timestamp \n seed \n count \n offset \n total \n body))`.
 *
 * Everything that decides what comes back is inside: change the body, the count,
 * the place in the column, the seed or the minute, and the signature no longer
 * matches — so a captured batch cannot be replayed as another one. The secret is the
 * key, so it is never sent — which is what makes this safe over plain http on a
 * trusted network, and what makes a captured request useless tomorrow once the
 * service checks the timestamp.
 */
export function signRequest(
  secret: string,
  timestamp: string,
  seed: string,
  count: number,
  offset: number,
  total: number,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${seed}\n${String(count)}\n${String(offset)}\n${String(total)}\n${body}`)
    .digest('hex');
}

/**
 * The value sent as `X-TDC-Seed`: eight hex digits derived from the env seed and
 * the sequence name, using the same hash the engine uses for its own per-stream
 * keys. Stable across runs, so a service can reproduce its own answers, and
 * different for every sequence, so two of them never receive the same stream.
 *
 * Beside the signature rather than inside the renderer because it is part of the
 * same wire contract, and because a service author reading either one wants both.
 * The four ports have always kept it here.
 */
export function httpSeedFor(envSeed: string, sequenceName: string): string {
  const [a] = cyrb128(`${envSeed}|http|${sequenceName}`);
  return (a >>> 0).toString(16).padStart(8, '0');
}

/** The request for one batch, exactly as it goes on the wire. */
export function buildHttpRequest(opts: HttpFetchOptions): RawRequest {
  const body = opts.inputs === undefined ? '' : opts.inputs.join('\n');
  return {
    url: opts.src,
    headers: contractHeaders(opts, body),
    body,
    timeoutMs: opts.timeoutMs,
    limit: MAX_RESPONSE_BYTES,
  };
}

/**
 * Run one batch against the service and wait for it. Returns exactly `count`
 * strings.
 *
 * `on_error="fail"` throws an {@link HttpServiceError}; `"empty"` returns
 * `count` blanks instead — EXCEPT for 429 and an ignored offset, which are fatal
 * under both: "slow down" cannot be reconciled with "fill the column", and a
 * source repeating its first batch is a broken contract, not a bad moment.
 */
export function fetchHttpBatch(
  opts: HttpFetchOptions,
  transport: SyncHttpTransport = syncHttpTransport(),
): string[] {
  if (opts.count <= 0) return [];
  return interpretHttpResult(opts, transport.wait(transport.start(buildHttpRequest(opts))));
}

/** Turn what the transport brought back into the batch's values, or a failure. */
export function interpretHttpResult(opts: HttpFetchOptions, raw: RawResult): string[] {
  const { src, count, timeoutMs } = opts;
  if (!raw.ok) {
    switch (raw.kind) {
      case 'timeout':
        return fail(
          opts,
          new HttpServiceError(`did not answer within ${String(timeoutMs)}ms`, 'timeout', src),
        );
      case 'too-large':
        return fail(
          opts,
          new HttpServiceError(
            `answered with more than ${String(MAX_RESPONSE_BYTES)} bytes — not a per-line reply`,
            'too-large',
            src,
            raw.status,
          ),
        );
      case 'connect':
        return fail(
          opts,
          new HttpServiceError(`could not be reached (${raw.message})`, 'network', src),
        );
      case 'read':
        return fail(
          opts,
          new HttpServiceError(`could not be read (${raw.message})`, 'network', src),
        );
    }
  }
  if (raw.status === 429) {
    // Always fatal — the one error on_error cannot soften.
    throw new HttpServiceError('returned 429 (rate limited)', 'rate-limited', src, 429);
  }
  if (raw.status < 200 || raw.status >= 300) {
    return fail(
      opts,
      new HttpServiceError(`returned ${String(raw.status)}`, 'status', src, raw.status),
    );
  }

  // A source cut into batches: the service has to show it read the offset, or
  // the second batch would be the first one again. A transform needs no echo —
  // each answer is computed from its own input line, wherever the batch sits.
  if (opts.inputs === undefined && totalOf(opts) > count) {
    const echoed = raw.headers['x-tdc-offset'];
    const offset = String(offsetOf(opts));
    if (echoed !== offset) {
      throw new HttpServiceError(
        echoed === undefined
          ? `answered the batch at row ${offset} without echoing X-TDC-Offset — a service ` +
              'with no in= column must read the offset and send it back, or every batch ' +
              'would repeat the first'
          : `answered the batch at row ${offset} with X-TDC-Offset ${echoed}`,
        'offset-ignored',
        src,
        raw.status,
      );
    }
  }

  const lines = splitLines(raw.text);
  if (lines.length !== count) {
    return fail(
      opts,
      new HttpServiceError(
        `returned ${String(lines.length)} line(s) for a batch of ${String(count)}`,
        'count-mismatch',
        src,
        raw.status,
      ),
    );
  }
  return lines;
}

/** Apply the on_error policy to a failure. */
function fail(opts: HttpFetchOptions, err: HttpServiceError): string[] {
  if (opts.onError === 'empty') return new Array<string>(opts.count).fill('');
  throw err;
}

/** Split the reply into value lines, tolerating a single trailing newline. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}
