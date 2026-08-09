/**
 * The client half of the `http` generator — see
 * docs/specs/2026-07-23-http-service-generator.md §4.
 *
 * A pure async function: given an endpoint, a count, and the input values for
 * one batch, it POSTs the §4 request and returns exactly `count` values in
 * order. It knows the wire contract and the error model, and nothing about
 * sequences or the engine — the caller wraps a thrown error with the sequence
 * name and a TDC code.
 *
 * Batch, never per-row: one call carries a whole chunk, which is what keeps a
 * billion rows to a thousand requests rather than a billion.
 */

import { createHmac } from 'node:crypto';

/** Why a service call failed. The caller turns this into a TDC diagnostic. */
export type HttpFailureKind =
  | 'status' // a non-2xx response (not 429)
  | 'rate-limited' // 429 — always fatal, even under on_error="empty"
  | 'timeout' // no answer within the timeout
  | 'network' // connection refused / DNS / socket error
  | 'count-mismatch' // 2xx, but not exactly `count` lines back
  | 'too-large'; // 2xx, but the body outgrew MAX_RESPONSE_BYTES

/**
 * The most of a reply this client will hold. The contract is one value per
 * line for `count` rows — a bounded, known-small answer — so a body that
 * outgrows this is a misbehaving service, and reading it to the end would
 * trade an error message for an OOM. The same limit lives in the other four
 * implementations.
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
      body,
    );
  }
  return headers;
}

/**
 * `hex(HMAC-SHA256(secret, timestamp \n seed \n count \n body))`.
 *
 * Everything that decides what comes back is inside: change the body, the count,
 * the seed or the minute, and the signature no longer matches. The secret is the
 * key, so it is never sent — which is what makes this safe over plain http on a
 * trusted network, and what makes a captured request useless tomorrow once the
 * service checks the timestamp.
 */
export function signRequest(
  secret: string,
  timestamp: string,
  seed: string,
  count: number,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${seed}\n${String(count)}\n${body}`)
    .digest('hex');
}

/**
 * Run one batch against the service. Resolves with exactly `count` strings.
 *
 * `on_error="fail"` throws an {@link HttpServiceError}; `"empty"` returns
 * `count` blanks instead — EXCEPT for 429, which is fatal under both, because
 * "slow down" and "stream the whole column" cannot be reconciled and pretending
 * otherwise yields quietly truncated data.
 */
export async function fetchHttpValues(opts: HttpFetchOptions): Promise<string[]> {
  const { src, count, timeoutMs } = opts;
  if (count <= 0) return [];

  const body = opts.inputs === undefined ? '' : opts.inputs.join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(src, {
      method: 'POST',
      headers: contractHeaders(opts, body),
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return fail(
      opts,
      aborted
        ? new HttpServiceError(`did not answer within ${String(timeoutMs)}ms`, 'timeout', src)
        : new HttpServiceError(
            `could not be reached (${err instanceof Error ? err.message : String(err)})`,
            'network',
            src,
          ),
    );
  }

  if (response.status === 429) {
    clearTimeout(timer);
    // Always fatal — the one error on_error cannot soften.
    throw new HttpServiceError('returned 429 (rate limited)', 'rate-limited', src, 429);
  }
  if (!response.ok) {
    clearTimeout(timer);
    void response.body?.cancel();
    return fail(
      opts,
      new HttpServiceError(`returned ${String(response.status)}`, 'status', src, response.status),
    );
  }

  // The timer stays armed through the body read: a service that answers its
  // headers promptly and then streams forever must still hit the timeout.
  let text: string;
  try {
    text = await readBounded(response, MAX_RESPONSE_BYTES);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof HttpServiceError) return fail(opts, err);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return fail(
      opts,
      aborted
        ? new HttpServiceError(`did not answer within ${String(timeoutMs)}ms`, 'timeout', src)
        : new HttpServiceError(
            `could not be read (${err instanceof Error ? err.message : String(err)})`,
            'network',
            src,
          ),
    );
  }
  clearTimeout(timer);

  const lines = splitLines(text);
  if (lines.length !== count) {
    return fail(
      opts,
      new HttpServiceError(
        `returned ${String(lines.length)} line(s) for a batch of ${String(count)}`,
        'count-mismatch',
        src,
        response.status,
      ),
    );
  }
  return lines;
}

/** Apply the on_error policy to a transport failure. */
function fail(opts: HttpFetchOptions, err: HttpServiceError): string[] {
  if (opts.onError === 'empty') return new Array<string>(opts.count).fill('');
  throw err;
}

/**
 * The whole body as text, or a `too-large` refusal the moment it outgrows
 * `limit` — without reading the rest first.
 */
async function readBounded(response: Response, limit: number): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > limit) {
      await reader.cancel();
      throw new HttpServiceError(
        `answered with more than ${String(limit)} bytes — not a per-line reply`,
        'too-large',
        response.url,
        response.status,
      );
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

/** Split the reply into value lines, tolerating a single trailing newline. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}
