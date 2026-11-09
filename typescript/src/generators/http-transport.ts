/**
 * A blocking HTTP POST for the `http` generator, in a runtime whose network is
 * asynchronous.
 *
 * The four ports call their service where the value is needed — inside the
 * column build, inside a streaming row, inside a scan — and wait. That is the
 * whole design of `http` at scale: the engine stops at the column that needs an
 * answer, asks, and goes on with the answer in hand. A column that reads the
 * answer (`if="Hash == …"`) then sees it, and memory holds one batch rather than
 * the column.
 *
 * Node cannot wait on a socket synchronously, so the request runs on a helper
 * thread and this thread sleeps on a shared counter until the answer is posted.
 * Every engine stays synchronous, exactly as in the other four languages.
 *
 * The helper is plain JavaScript evaluated from a string rather than a file
 * beside this one: it then loads the same way from the compiled package, from
 * the TypeScript sources a test runs, and from inside another worker (`--jobs`).
 * It is deliberately dumb — a POST with a timeout and a size cap, nothing about
 * the TDC contract. Every rule of the contract stays in `http.ts`, on this side.
 *
 * One consequence for a caller of the library: the service must not run on the
 * thread that renders. This thread is asleep while it waits, so a service served
 * by its own event loop could never answer. A separate process or worker is fine.
 */

import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from 'node:worker_threads';

/** One POST, fully described — what the helper thread sends. */
export interface RawRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  /** Bytes of reply the helper will hold before refusing the rest. */
  readonly limit: number;
}

/**
 * What came back. A status outside 2xx is still `ok: true` here — whether it is
 * a failure, and which kind, is the contract's decision, not the transport's.
 */
export type RawResult =
  | {
      readonly ok: true;
      readonly status: number;
      /** Response headers, names in lower case. */
      readonly headers: Readonly<Record<string, string>>;
      /** The body for a 2xx reply; '' otherwise. */
      readonly text: string;
    }
  | {
      readonly ok: false;
      /** `connect`: never got a reply. `read`: the reply broke off. */
      readonly kind: 'timeout' | 'connect' | 'read' | 'too-large';
      readonly message: string;
      readonly status?: number | undefined;
    };

/**
 * The helper thread. CommonJS, because an evaluated worker is a script.
 *
 * It posts every result on the transferred port FIRST and bumps the counter
 * second, so whoever wakes on the counter finds the message already queued.
 */
const HELPER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const port = workerData.port;
const counter = new Int32Array(workerData.counter);
function settle(id, result) {
  port.postMessage({ id, result });
  Atomics.add(counter, 0, 1);
  Atomics.notify(counter, 0);
}
parentPort.on('message', async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  let response;
  try {
    response = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    settle(req.id, { ok: false, kind: aborted ? 'timeout' : 'connect', message: aborted ? '' : String((err && err.message) || err) });
    return;
  }
  const headers = {};
  response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  if (response.status < 200 || response.status >= 300) {
    clearTimeout(timer);
    try { await response.body?.cancel(); } catch {}
    settle(req.id, { ok: true, status: response.status, headers, text: '' });
    return;
  }
  // The timer stays armed through the body: a service that answers its headers
  // promptly and then streams forever must still hit the timeout.
  try {
    const reader = response.body ? response.body.getReader() : undefined;
    if (!reader) {
      const text = await response.text();
      clearTimeout(timer);
      settle(req.id, { ok: true, status: response.status, headers, text });
      return;
    }
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > req.limit) {
        clearTimeout(timer);
        try { await reader.cancel(); } catch {}
        settle(req.id, { ok: false, kind: 'too-large', message: '', status: response.status });
        return;
      }
      chunks.push(value);
    }
    clearTimeout(timer);
    const joined = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
    settle(req.id, { ok: true, status: response.status, headers, text: new TextDecoder().decode(joined) });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && err.name === 'AbortError';
    settle(req.id, { ok: false, kind: aborted ? 'timeout' : 'read', message: aborted ? '' : String((err && err.message) || err) });
  }
});
`;

/**
 * How long past its own timeout a request may stay unanswered before the waiter
 * gives up on the helper itself. The helper enforces the timeout; this only
 * catches a helper that died, which would otherwise be a wait with no end.
 */
const HELPER_GRACE_MS = 10_000;

interface Pending {
  readonly deadline: number;
}

/**
 * Requests in flight on one helper thread, and a way to wait for any of them.
 *
 * `start` returns at once, so a caller can have the next batch on the wire while
 * it renders this one; `wait` blocks until that particular answer is in.
 */
export class SyncHttpTransport {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly counter: Int32Array;
  private readonly pending = new Map<number, Pending>();
  private readonly arrived = new Map<number, RawResult>();
  private nextId = 1;

  public constructor() {
    const shared = new SharedArrayBuffer(4);
    this.counter = new Int32Array(shared);
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(HELPER_SOURCE, {
      eval: true,
      workerData: { port: port2, counter: shared },
      transferList: [port2],
    });
    // Neither the helper nor its port may keep a finished process alive.
    this.worker.unref();
    this.port.unref();
  }

  /** Put a request on the wire. Returns the ticket to {@link wait} on. */
  public start(request: RawRequest): number {
    const id = this.nextId++;
    this.pending.set(id, { deadline: Date.now() + request.timeoutMs + HELPER_GRACE_MS });
    this.worker.postMessage({ id, ...request });
    return id;
  }

  /** Block until the answer to `ticket` is in, and return it. */
  public wait(ticket: number): RawResult {
    for (;;) {
      const got = this.arrived.get(ticket);
      if (got !== undefined) {
        this.arrived.delete(ticket);
        this.pending.delete(ticket);
        return got;
      }
      // Read the counter BEFORE draining: a result posted between the drain and
      // the sleep then changes the counter, and the sleep returns at once.
      const seen = Atomics.load(this.counter, 0);
      const message = receiveMessageOnPort(this.port) as
        { message: { id: number; result: RawResult } } | undefined;
      if (message !== undefined) {
        this.arrived.set(message.message.id, message.message.result);
        continue;
      }
      const deadline = this.pending.get(ticket)?.deadline ?? Date.now();
      const left = deadline - Date.now();
      if (left <= 0) {
        this.pending.delete(ticket);
        return { ok: false, kind: 'timeout', message: '' };
      }
      Atomics.wait(this.counter, 0, seen, left);
    }
  }
}

let shared: SyncHttpTransport | undefined;

/** The transport for this thread, started on first use. */
export function syncHttpTransport(): SyncHttpTransport {
  shared ??= new SyncHttpTransport();
  return shared;
}
