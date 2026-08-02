import { afterEach, describe, expect, it } from 'vitest';

import { fetchHttpValues, HttpServiceError } from '../../src/generators/http.js';
import { startService, type ServiceHandle } from '../fixtures/http-service.js';

/**
 * The wire-contract client, driven against the real fixture service. This is
 * the §4 contract and the §5 error model, isolated from the engine.
 */

let service: ServiceHandle | undefined;
afterEach(async () => {
  await service?.close();
  service = undefined;
});

describe('fetchHttpValues', () => {
  it('sends inputs and returns one transformed value per row', async () => {
    service = await startService({ mode: 'ok' });
    const out = await fetchHttpValues({
      src: service.url,
      count: 3,
      inputs: ['a', 'b', 'c'],
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(out).toEqual(['svc-a', 'svc-b', 'svc-c']);
  });

  it('a pure source (no inputs) still gets count values', async () => {
    service = await startService({ mode: 'ok', transform: (_l, i) => `n${String(i)}` });
    const out = await fetchHttpValues({
      src: service.url,
      count: 4,
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(out).toEqual(['n0', 'n1', 'n2', 'n3']);
  });

  it('count 0 makes no request and returns nothing', async () => {
    service = await startService({ mode: 'ok' });
    const out = await fetchHttpValues({
      src: service.url,
      count: 0,
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(out).toEqual([]);
    expect(service.requests()).toBe(0);
  });

  describe('on_error="fail" throws with the transport fact', () => {
    it('on a non-2xx status', async () => {
      service = await startService({
        mode: 'error-after',
        errorAfterRequests: 0,
        errorStatus: 503,
      });
      await expect(
        fetchHttpValues({
          src: service.url,
          count: 1,
          inputs: ['x'],
          onError: 'fail',
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ kind: 'status', status: 503 });
    });

    it('on a timeout against a hanging service', async () => {
      service = await startService({ mode: 'hang' });
      await expect(
        fetchHttpValues({
          src: service.url,
          count: 1,
          inputs: ['x'],
          onError: 'fail',
          timeoutMs: 150,
        }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('on a service that floods instead of answering per line', async () => {
      service = await startService({ mode: 'flood' });
      // The refusal fires the moment the body outgrows the cap, without
      // reading the rest of an endless stream first.
      await expect(
        fetchHttpValues({
          src: service.url,
          count: 1,
          inputs: ['x'],
          onError: 'fail',
          timeoutMs: 30_000,
        }),
      ).rejects.toMatchObject({ kind: 'too-large' });
    }, 30_000);

    it('a hang after the headers still hits the timeout', async () => {
      // `slow` delays the BODY: headers arrive, then nothing for latencyMs.
      // The timer must cover the body read, not just the connection.
      service = await startService({ mode: 'slow', latencyMs: 60_000 });
      await expect(
        fetchHttpValues({
          src: service.url,
          count: 1,
          inputs: ['x'],
          onError: 'fail',
          timeoutMs: 200,
        }),
      ).rejects.toMatchObject({ kind: 'timeout' });
    });

    it('on a connection that is refused', async () => {
      // Nothing listening on this port.
      await expect(
        fetchHttpValues({
          src: 'http://127.0.0.1:1/gen',
          count: 1,
          inputs: ['x'],
          onError: 'fail',
          timeoutMs: 1000,
        }),
      ).rejects.toMatchObject({ kind: 'network' });
    });

    it('on a reply whose line count does not match the batch', async () => {
      service = await startService({ mode: 'ok', dropLines: 1 });
      await expect(
        fetchHttpValues({
          src: service.url,
          count: 3,
          inputs: ['a', 'b', 'c'],
          onError: 'fail',
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ kind: 'count-mismatch' });
    });
  });

  describe('on_error="empty" softens a failure to blanks', () => {
    it('on a non-2xx status', async () => {
      service = await startService({ mode: 'error-after', errorAfterRequests: 0 });
      const out = await fetchHttpValues({
        src: service.url,
        count: 3,
        inputs: ['a', 'b', 'c'],
        onError: 'empty',
        timeoutMs: 2000,
      });
      expect(out).toEqual(['', '', '']);
    });

    it('on a timeout', async () => {
      service = await startService({ mode: 'hang' });
      const out = await fetchHttpValues({
        src: service.url,
        count: 2,
        inputs: ['a', 'b'],
        onError: 'empty',
        timeoutMs: 150,
      });
      expect(out).toEqual(['', '']);
    });
  });

  describe('429 is fatal under both policies', () => {
    it('throws even with on_error="empty"', async () => {
      service = await startService({ mode: 'rate-limit' });
      await expect(
        fetchHttpValues({
          src: service.url,
          count: 2,
          inputs: ['a', 'b'],
          onError: 'empty',
          timeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ kind: 'rate-limited', status: 429 });
    });
  });

  it('the thrown error is an HttpServiceError naming the url', async () => {
    service = await startService({ mode: 'rate-limit' });
    let err: unknown;
    try {
      await fetchHttpValues({
        src: service.url,
        count: 1,
        inputs: ['x'],
        onError: 'fail',
        timeoutMs: 2000,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpServiceError);
    expect((err as HttpServiceError).url).toBe(service.url);
  });
});
