/**
 * The test service's server, on a thread of its own.
 *
 * The generator now WAITS for its service on the thread that renders — exactly
 * as the other four implementations do — so a service on that same thread could
 * never answer. This file is the server; `http-service.ts` starts it and reads
 * back what it saw.
 *
 * Plain JavaScript because a worker loads a file as Node finds it, whatever the
 * test runner does with TypeScript.
 */

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

const opts = workerData.options;
/** Every request is reported here, BEFORE it is answered — so whoever got the answer can read it. */
const log = workerData.log;

const mode = opts.mode ?? 'ok';
const transform = opts.transform ? (0, eval)(`(${opts.transform})`) : (line) => `svc-${line}`;
const errorStatus = opts.errorStatus ?? 500;
const rateLimitEvery = opts.rateLimitEvery ?? 1;
const latencyMs = opts.latencyMs ?? 50;
const echoOffset = opts.echoOffset ?? true;

let seen = 0;
let inFlight = 0;
let firstAt;
let closed = false;
let unsafeCounter = 0;

const monotonic = () => Number(process.hrtime.bigint() / 1_000_000n);

const wait = (ms) =>
  new Promise((resolve) => {
    const t = setInterval(() => {
      if (closed) {
        clearInterval(t);
        resolve();
      }
    }, 5);
    setTimeout(() => {
      clearInterval(t);
      resolve();
    }, ms);
  });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendLines(res, lines, offset) {
  const body = lines.join('\n');
  const headers = { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) };
  if (echoOffset) headers['X-TDC-Offset'] = String(offset);
  res.writeHead(200, headers);
  res.end(body);
}

function shouldErrorAfter(requestIndex) {
  if (opts.errorAfterRequests !== undefined && requestIndex > opts.errorAfterRequests) return true;
  return (
    opts.errorAfterMs !== undefined &&
    firstAt !== undefined &&
    monotonic() - firstAt >= opts.errorAfterMs
  );
}

async function handle(req, res) {
  seen += 1;
  inFlight += 1;
  const requestIndex = seen;
  firstAt ??= monotonic();
  try {
    const count = Number(req.headers['x-tdc-count'] ?? '0');
    const offsetHeader = req.headers['x-tdc-offset'];
    const totalHeader = req.headers['x-tdc-total'];
    const offset = offsetHeader === undefined ? 0 : Number(offsetHeader);
    const seed = String(req.headers['x-tdc-seed'] ?? '');
    const body = await readBody(req);
    const inputHeader = req.headers['x-tdc-input'];
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
    const signature = String(req.headers['x-tdc-signature'] ?? '');

    log.postMessage({
      seed,
      input: declared,
      signature,
      count,
      offset: offsetHeader === undefined ? undefined : offset,
      total: totalHeader === undefined ? undefined : Number(totalHeader),
      inFlight,
    });

    if (opts.secret !== undefined) {
      const timestamp = String(req.headers['x-tdc-timestamp'] ?? '');
      const mine = createHmac('sha256', opts.secret)
        .update(
          `${timestamp}\n${seed}\n${String(count)}\n${offsetHeader ?? ''}\n${totalHeader ?? ''}\n${body}`,
        )
        .digest('hex');
      if (signature === '' || signature !== mine) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('bad signature');
        return;
      }
    }

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
    if (mode === 'hang') return;
    if (mode === 'flood') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const junk = 'x'.repeat(64 * 1024);
      const push = () => {
        if (closed || res.writableEnded) return;
        if (res.write(junk)) setImmediate(push);
        else res.once('drain', push);
      };
      push();
      return;
    }
    if (mode === 'slow') await wait(latencyMs);

    const source = (i) => (i < inputs.length ? (inputs[i] ?? '') : String(i));

    if (mode === 'concurrent-unsafe') {
      const lines = [];
      for (let i = 0; i < n; i++) {
        const id = unsafeCounter;
        await new Promise((r) => setTimeout(r, 1));
        unsafeCounter = id + 1;
        lines.push(`id-${String(id)}`);
      }
      sendLines(res, lines, offset);
      return;
    }

    const lines = Array.from({ length: n }, (_, i) => transform(source(i), i, offset + i));
    const drop = opts.dropLines ?? 0;
    sendLines(res, drop > 0 ? lines.slice(0, Math.max(0, lines.length - drop)) : lines, offset);
  } finally {
    inFlight -= 1;
  }
}

const server = createServer((req, res) => {
  void handle(req, res);
});

parentPort.on('message', (msg) => {
  if (msg === 'close') {
    closed = true;
    server.closeAllConnections();
    server.close(() => parentPort.postMessage({ closed: true }));
  }
});

server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ port: server.address().port });
});
