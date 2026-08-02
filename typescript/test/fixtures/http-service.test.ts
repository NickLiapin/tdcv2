import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { startService, type ServiceHandle } from './http-service.js';

/**
 * Locks the fixture's behaviour before anything is built on top of it. Every
 * mode from the spec's §8 is exercised with a raw HTTP client, so the wire
 * contract is verified from the server side independently of the generator.
 */

/** Minimal client: POST N inputs, resolve with {status, lines} or a network error. */
function post(
  url: string,
  count: number,
  inputs: readonly string[] = [],
  timeoutMs = 2000,
): Promise<{ status: number; lines: string[] }> {
  const body = inputs.join('\n');
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        headers: { 'X-TDC-Count': String(count), 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => {
          data += c.toString();
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, lines: data === '' ? [] : data.split('\n') });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('client timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

let service: ServiceHandle | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
});

describe('test service fixture', () => {
  it('ok: returns one transformed line per input, in order', async () => {
    service = await startService({ mode: 'ok' });
    const { status, lines } = await post(service.url, 3, ['a', 'b', 'c']);
    expect(status).toBe(200);
    expect(lines).toEqual(['svc-a', 'svc-b', 'svc-c']);
  });

  it('ok: a pure source (empty body) returns N lines from the count header', async () => {
    service = await startService({ mode: 'ok', transform: (_l, i) => `row${String(i)}` });
    const { lines } = await post(service.url, 4, []);
    expect(lines).toEqual(['row0', 'row1', 'row2', 'row3']);
  });

  it('error-after: correct until the Nth request, then the error status', async () => {
    service = await startService({ mode: 'error-after', errorAfterRequests: 2, errorStatus: 503 });
    expect((await post(service.url, 1, ['x'])).status).toBe(200);
    expect((await post(service.url, 1, ['x'])).status).toBe(200);
    expect((await post(service.url, 1, ['x'])).status).toBe(503);
  });

  it('rate-limit: returns 429', async () => {
    service = await startService({ mode: 'rate-limit' });
    expect((await post(service.url, 1, ['x'])).status).toBe(429);
  });

  it('slow: answers correctly, but not before its latency', async () => {
    service = await startService({ mode: 'slow', latencyMs: 120 });
    const t = process.hrtime.bigint();
    const { lines } = await post(service.url, 1, ['x']);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    expect(lines).toEqual(['svc-x']);
    expect(ms).toBeGreaterThan(90);
  });

  it('hang: never answers, so the client times out', async () => {
    service = await startService({ mode: 'hang' });
    await expect(post(service.url, 1, ['x'], 200)).rejects.toThrow(/timeout/);
  });

  it('concurrent-unsafe: distinct ids when serial', async () => {
    service = await startService({ mode: 'concurrent-unsafe' });
    const a = await post(service.url, 2, ['', '']);
    const b = await post(service.url, 2, ['', '']);
    const ids = [...a.lines, ...b.lines];
    expect(new Set(ids).size).toBe(ids.length); // all distinct
  });

  it('concurrent-unsafe: collides under concurrency', async () => {
    service = await startService({ mode: 'concurrent-unsafe' });
    const [a, b] = await Promise.all([
      post(service.url, 3, ['', '', '']),
      post(service.url, 3, ['', '', '']),
    ]);
    const ids = [...a.lines, ...b.lines];
    // Overlapping read-modify-write hands the same id out twice.
    expect(new Set(ids).size).toBeLessThan(ids.length);
    expect(service.concurrentPeak()).toBeGreaterThan(1);
  });

  it('counts the requests it accepted', async () => {
    service = await startService({ mode: 'ok' });
    await post(service.url, 1, ['x']);
    await post(service.url, 1, ['y']);
    expect(service.requests()).toBe(2);
  });
});
