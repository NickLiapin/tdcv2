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
 *
 * The server runs on a thread of its own (`http-service-worker.mjs`): the
 * generator waits for its answer on the thread that renders, so a service on
 * that thread could never reply. Every request is reported back before it is
 * answered, and the getters below drain those reports synchronously — whoever
 * holds an answer can already read what the service saw.
 */

import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

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
  /**
   * `ok`/`slow`: how each input line becomes an output line. Default `svc-<line>`.
   *
   * `index` is the line's place in its batch, `row` its place in the column
   * (`X-TDC-Offset` + index). It runs on the service's own thread, rebuilt from
   * its source text — so it may use its arguments and globals, never a variable
   * of the test around it.
   */
  readonly transform?: (line: string, index: number, row: number) => string;
  /**
   * Send `X-TDC-Offset` back, as the contract asks a source to. Default true —
   * false is a service written before batches, which a multi-batch source run
   * must refuse rather than trust.
   */
  readonly echoOffset?: boolean;
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
  /** `X-TDC-Offset` per request — `undefined` where absent. */
  offsets(): readonly (number | undefined)[];
  /** `X-TDC-Total` per request — `undefined` where absent. */
  totals(): readonly (number | undefined)[];
  /** `X-TDC-Count` per request. */
  counts(): readonly number[];
  close(): Promise<void>;
}

interface Seen {
  readonly seed: string;
  readonly input: number | undefined;
  readonly signature: string;
  readonly count: number;
  readonly offset: number | undefined;
  readonly total: number | undefined;
  readonly inFlight: number;
}

/**
 * Start the fixture. Resolves once it is listening, with a handle carrying the
 * URL to point the generator at and the counters the tests assert on.
 */
export function startService(opts: ServiceOptions = {}): Promise<ServiceHandle> {
  const { port1: log, port2 } = new MessageChannel();
  const worker = new Worker(new URL('./http-service-worker.mjs', import.meta.url), {
    workerData: {
      options: { ...opts, transform: opts.transform?.toString() },
      log: port2,
    },
    transferList: [port2],
  });
  const seen: Seen[] = [];
  const drain = (): Seen[] => {
    for (;;) {
      const got = receiveMessageOnPort(log) as { message: Seen } | undefined;
      if (got === undefined) return seen;
      seen.push(got.message);
    }
  };

  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (msg: { port: number }) => {
      resolve({
        url: `http://127.0.0.1:${String(msg.port)}/gen`,
        port: msg.port,
        requests: () => drain().length,
        seeds: () => drain().map((s) => s.seed),
        inputCounts: () => drain().map((s) => s.input),
        signatures: () => drain().map((s) => s.signature),
        offsets: () => drain().map((s) => s.offset),
        totals: () => drain().map((s) => s.total),
        counts: () => drain().map((s) => s.count),
        concurrentPeak: () => Math.max(0, ...drain().map((s) => s.inFlight)),
        close: () =>
          new Promise<void>((done) => {
            worker.once('message', () => {
              log.close();
              void worker.terminate().then(() => {
                done();
              });
            });
            worker.postMessage('close');
          }),
      });
    });
  });
}
