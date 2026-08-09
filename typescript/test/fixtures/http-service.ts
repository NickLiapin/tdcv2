/**
 * The test service for the `http` generator — see
 * docs/specs/2026-07-23-http-service-generator.md §8.
 *
 * This is the FIXTURE the generator is driven against, not a stand-in. The point
 * of the generator is a real socket, real latency and real failure, so the tests
 * point it at this and watch what happens. It speaks the §4 wire contract:
 *
 *   POST {url}
 *   X-TDC-Count: N            how many values are wanted
 *   body: N input lines       (newline-delimited; empty for a pure source)
 *   → N response lines        one per input, in order
 *
 * It runs in selectable modes so every failure branch of the design can be
 * exercised on purpose rather than hoped for. It binds to 127.0.0.1 on an
 * ephemeral port (0 → the OS picks one), so the suite needs no fixed port and
 * nothing beyond loopback.
 */

import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

export type ServiceMode =
  | 'ok' // answers every request correctly and promptly
  | 'error-after' // correct for a while, then 500 (by request count or elapsed ms)
  | 'rate-limit' // 429 on some requests
  | 'hang' // accepts the connection and never answers
  | 'slow' // correct, but with injected latency
  | 'concurrent-unsafe' // wrong when called concurrently, correct when serial
  | 'flood'; // 200, then streams junk far past any sane reply size

export interface ServiceOptions {
  readonly mode?: ServiceMode;
  /** `ok`/`slow`: how each input line becomes an output line. Default `svc-<line>`. */
  readonly transform?: (line: string, index: number) => string;
  /** `error-after`: start failing once this many requests have been served. */
  readonly errorAfterRequests?: number;
  /** `error-after`: start failing this many ms after the first request. */
  readonly errorAfterMs?: number;
  /** `error-after`: the status to fail with. Default 500. */
  readonly errorStatus?: number;
  /** `rate-limit`: return 429 on every Nth request (1 = always). Default 1. */
  readonly rateLimitEvery?: number;
  /** `slow`: ms of latency before answering. Default 50. */
  readonly latencyMs?: number;
  /** `ok`: drop this many lines from the reply, to force a count mismatch. */
  readonly dropLines?: number;
  /**
   * Demand a signed request, and check it with this secret.
   *
   * Unset means the service accepts anything that reaches it, which is what a
   * service on a trusted socket may reasonably do — the point of the option is
   * to prove the OTHER direction works.
   */
  readonly secret?: string;
}

export interface ServiceHandle {
  /** The endpoint to hand to the generator's `src`. */
  readonly url: string;
  readonly port: number;
  /** Total requests the service has accepted. */
  requests(): number;
  /** Highest number of requests it was handling at the same instant. */
  concurrentPeak(): number;
  /** The `X-TDC-Seed` of every request accepted, in order — '' when absent. */
  seeds(): readonly string[];
  /** `X-TDC-Input` per request — `undefined` where the header was absent. */
  inputCounts(): readonly (number | undefined)[];
  /** The `X-TDC-Signature` of every request, in order — '' when absent. */
  signatures(): readonly string[];
  close(): Promise<void>;
}

const wait = (ms: number, signal?: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const t = setInterval(() => {
      if (signal?.()) {
        clearInterval(t);
        resolve();
      }
    }, 5);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, ms);
  });

/** Read a whole request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', reject);
  });
}

function sendLines(res: ServerResponse, lines: readonly string[]): void {
  const body = lines.join('\n');
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * Start the fixture. Resolves once it is listening, with a handle carrying the
 * URL to point the generator at and the counters the tests assert on.
 */
export function startService(opts: ServiceOptions = {}): Promise<ServiceHandle> {
  const mode = opts.mode ?? 'ok';
  const transform = opts.transform ?? ((line: string) => `svc-${line}`);
  const errorStatus = opts.errorStatus ?? 500;
  const rateLimitEvery = opts.rateLimitEvery ?? 1;
  const latencyMs = opts.latencyMs ?? 50;

  const seedsSeen: string[] = [];
  /** `X-TDC-Input` per request — `undefined` where the header was absent. */
  const inputsSeen: (number | undefined)[] = [];
  const signaturesSeen: string[] = [];
  let seen = 0; // requests accepted, ever
  let inFlight = 0; // requests being handled right now
  let peak = 0;
  let firstAt: number | undefined; // ms of the first request (for error-after)
  let closed = false;

  // A shared counter the concurrent-unsafe mode mangles: it reads, yields, then
  // writes, so two overlapping requests hand out the SAME id. Serial callers
  // never overlap and always get distinct ids.
  let unsafeCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    seen += 1;
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    const requestIndex = seen;
    firstAt ??= monotonic();

    try {
      const count = Number(req.headers['x-tdc-count'] ?? '0');
      const seed = String(req.headers['x-tdc-seed'] ?? '');
      seedsSeen.push(seed);
      const body = await readBody(req);
      // `X-TDC-Input` is what tells a transform from a source. Without it an
      // empty body was ambiguous — a column of one empty value looks exactly
      // like "invent a value" — so a service that reads it can answer both
      // honestly. Absent means source; present means that many input lines,
      // zero included.
      const inputHeader = req.headers['x-tdc-input'];
      inputsSeen.push(inputHeader === undefined ? undefined : Number(inputHeader));
      // Absent means "read the body as you always did" — a service written
      // before the header keeps working unchanged, which is the whole reason
      // this is a header and not a new body format. Present is what settles the
      // one case the body alone cannot: an empty body with `1` is one empty
      // input, with `0` it is none.
      const declared = inputHeader === undefined ? undefined : Number(inputHeader);
      const inputs =
        declared === undefined
          ? body.length === 0
            ? []
            : body.split('\n')
          : declared === 0
            ? []
            : body.length === 0
              ? ['']
              : body.split('\n');
      const n = Number.isFinite(count) && count > 0 ? count : inputs.length;

      // The signature, when the service is configured to demand one. Recomputed
      // from the same four things the client signed, with the same secret; a
      // request that does not match is refused before any work is done.
      if (opts.secret !== undefined) {
        const given = String(req.headers['x-tdc-signature'] ?? '');
        const timestamp = String(req.headers['x-tdc-timestamp'] ?? '');
        signaturesSeen.push(given);
        const mine = createHmac('sha256', opts.secret)
          .update(`${timestamp}\n${seed}\n${String(count)}\n${body}`)
          .digest('hex');
        if (given === '' || given !== mine) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('bad signature');
          return;
        }
      }

      // ---- failure modes, decided before doing any work ----
      if (mode === 'rate-limit' && requestIndex % rateLimitEvery === 0) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('slow down');
        return;
      }
      if (mode === 'error-after' && shouldErrorAfter(requestIndex)) {
        res.writeHead(errorStatus, { 'Content-Type': 'text/plain' });
        res.end('deliberate failure');
        return;
      }
      if (mode === 'hang') {
        // Never answer. Leave the socket open until the server is torn down.
        return;
      }
      if (mode === 'flood') {
        // A 200 followed by junk with no end in sight — the client's size cap
        // is what has to stop this, not the service's manners.
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        const junk = 'x'.repeat(64 * 1024);
        const push = (): void => {
          if (closed || res.writableEnded) return;
          // Respect backpressure so the flood does not buffer in this process.
          if (res.write(junk)) setImmediate(push);
          else res.once('drain', push);
        };
        push();
        return;
      }
      if (mode === 'slow') {
        await wait(latencyMs, () => closed);
      }

      // ---- the answer: N lines, in order ----
      const source = (i: number): string => (i < inputs.length ? (inputs[i] ?? '') : String(i));

      if (mode === 'concurrent-unsafe') {
        const lines: string[] = [];
        for (let i = 0; i < n; i++) {
          const id = unsafeCounter; // read
          // A real timer gap, not a microtask: it reliably lets an overlapping
          // request run its own read before this one writes, so both see `id`.
          await new Promise((r) => setTimeout(r, 1));
          unsafeCounter = id + 1; // write
          lines.push(`id-${String(id)}`);
        }
        sendLines(res, lines);
        return;
      }

      const lines = Array.from({ length: n }, (_, i) => transform(source(i), i));
      const drop = opts.dropLines ?? 0;
      sendLines(res, drop > 0 ? lines.slice(0, Math.max(0, lines.length - drop)) : lines);
    } finally {
      inFlight -= 1;
    }
  }

  function shouldErrorAfter(requestIndex: number): boolean {
    if (opts.errorAfterRequests !== undefined && requestIndex > opts.errorAfterRequests) {
      return true;
    }
    if (
      opts.errorAfterMs !== undefined &&
      firstAt !== undefined &&
      monotonic() - firstAt >= opts.errorAfterMs
    ) {
      return true;
    }
    return false;
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${String(addr.port)}/gen`,
        port: addr.port,
        requests: () => seen,
        seeds: () => seedsSeen,
        inputCounts: () => inputsSeen,
        signatures: () => signaturesSeen,
        concurrentPeak: () => peak,
        close: () =>
          new Promise<void>((done) => {
            closed = true;
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/** A millisecond clock that is allowed here (fixture code, never the engine). */
function monotonic(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
