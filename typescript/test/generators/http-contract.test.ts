/**
 * The two things a request says about itself beyond its body.
 *
 * `X-TDC-Input` closes an ambiguity that used to reach the service as a wrong
 * answer: `in=` naming a column of one empty value sends an empty body, which is
 * byte-for-byte what a pure source sends, so the service invented a value where
 * it had been asked to process one. Measured before the header existed:
 * `city=[] handled=[68784219]`.
 *
 * `X-TDC-Signature` is what lets a service tell the generator from anyone else
 * who can reach the port. The secret is the key, never the message — it does not
 * appear in any request this file makes, which the assertions check.
 *
 * Every expectation here is measured against a service that is really running.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHttpRequest,
  contractHeaders,
  fetchHttpBatch,
  signRequest,
  type HttpFetchOptions,
} from '../../src/generators/http.js';
import { HttpSecretError, resolveHttpSecret } from '../../src/generators/http-secret.js';
import { startService, type ServiceHandle } from '../fixtures/http-service.js';

const fetchHttpValues = (opts: HttpFetchOptions): Promise<string[]> =>
  Promise.resolve().then(() => fetchHttpBatch(opts));

let service: ServiceHandle | undefined;

afterEach(async () => {
  await service?.close();
  service = undefined;
});

describe('X-TDC-Input separates a transform from a source', () => {
  it('a source sends no header at all', async () => {
    service = await startService({ transform: () => 'made' });
    const values = await fetchHttpValues({
      src: service.url,
      count: 2,
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(values).toHaveLength(2);
    expect(service.inputCounts()).toEqual([undefined]);
  });

  it('one empty input is one input, not none', async () => {
    // The case the header exists for. The body is empty either way; only the
    // header tells the two apart, and the service echoes what it was handed.
    service = await startService({ transform: (line) => `handled[${line}]` });
    const values = await fetchHttpValues({
      src: service.url,
      count: 1,
      inputs: [''],
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(service.inputCounts()).toEqual([1]);
    expect(values).toEqual(['handled[]']);
  });

  it('and a non-empty batch counts its lines', async () => {
    service = await startService({ transform: (line) => line.toUpperCase() });
    const values = await fetchHttpValues({
      src: service.url,
      count: 3,
      inputs: ['a', 'b', 'c'],
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(service.inputCounts()).toEqual([3]);
    expect(values).toEqual(['A', 'B', 'C']);
  });
});

describe('a signed request', () => {
  const SECRET = 'k7Fm2p-test-secret';

  it('is accepted by a service holding the same secret', async () => {
    service = await startService({ secret: SECRET, transform: (line) => `ok-${line}` });
    const values = await fetchHttpValues({
      src: service.url,
      count: 2,
      inputs: ['x', 'y'],
      seed: 'abc123',
      secret: SECRET,
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(values).toEqual(['ok-x', 'ok-y']);
    expect(service.signatures()[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is refused when the secrets differ', async () => {
    service = await startService({ secret: SECRET });
    await expect(
      fetchHttpValues({
        src: service.url,
        count: 1,
        seed: 'abc123',
        secret: 'a-different-secret',
        onError: 'fail',
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/returned 401/);
  });

  it('is accepted at an address the five HTTP clients would each have sent differently', async () => {
    // The service checks against the request line it actually received. A path
    // and query in the shapes that differ between clients (an escape of a plain
    // letter, a quote in the query, a space, an empty ? at the end of another
    // address) only pass if what was signed is what went on the wire.
    service = await startService({ secret: SECRET, transform: (line) => `ok-${line}` });
    const values = await fetchHttpValues({
      src: `${service.url}/%7eme/%d0%bf a?k=it's&v=%41`,
      count: 1,
      inputs: ['x'],
      seed: 'abc123',
      secret: SECRET,
      onError: 'fail',
      timeoutMs: 2000,
    });
    expect(values).toEqual(['ok-x']);
  });

  it('is refused at another address of the same service', async () => {
    // The replay found while writing the article on http (2026-11-19): one
    // service, two addresses, one secret. A request signed for the first one,
    // sent unchanged to the second, must not be answered.
    service = await startService({ secret: SECRET, transform: (line) => `ok-${line}` });
    const signedFor = buildHttpRequest({
      src: `${service.url}/hash`,
      count: 1,
      inputs: ['qwerty'],
      seed: 'abc123',
      secret: SECRET,
      onError: 'fail',
      timeoutMs: 2000,
    });
    const replay = (url: string): Promise<number> =>
      fetch(url, { method: 'POST', headers: signedFor.headers, body: signedFor.body }).then(
        async (r) => {
          await r.text();
          return r.status;
        },
      );
    expect(await replay(`${service.url}/hash`)).toBe(200);
    expect(await replay(`${service.url}/invite`)).toBe(401);
  });

  it('is refused when it carries no signature at all', async () => {
    service = await startService({ secret: SECRET });
    await expect(
      fetchHttpValues({ src: service.url, count: 1, onError: 'fail', timeoutMs: 2000 }),
    ).rejects.toThrow(/returned 401/);
  });

  it('never puts the secret on the wire', () => {
    const headers = contractHeaders(
      {
        src: 'http://127.0.0.1:1/x',
        count: 4,
        seed: 'seed1',
        secret: SECRET,
        onError: 'fail',
        timeoutMs: 1000,
        nowMs: 1_786_000_000_000,
      },
      'body',
    );
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    expect(headers['X-TDC-Timestamp']).toBe('1786000000');
  });

  it('covers the address, the timestamp, the seed, the count, the place in the column and the body', () => {
    const sign = (
      over: Partial<{
        method: string;
        target: string;
        timestamp: string;
        seed: string;
        count: number;
        offset: number;
        total: number;
        body: string;
      }> = {},
    ): string => {
      const v = {
        method: 'POST',
        target: '/gen',
        timestamp: '1786000000',
        seed: 'seed1',
        count: 4,
        offset: 0,
        total: 4,
        body: 'body',
        ...over,
      };
      return signRequest(
        SECRET,
        v.method,
        v.target,
        v.timestamp,
        v.seed,
        v.count,
        v.offset,
        v.total,
        v.body,
      );
    };
    const base = sign();
    expect(sign({ timestamp: '1786000001' })).not.toBe(base);
    expect(sign({ seed: 'seed2' })).not.toBe(base);
    expect(sign({ count: 5 })).not.toBe(base);
    expect(sign({ body: 'other' })).not.toBe(base);
    // A request signed for one address is not a request for another one of the
    // same service — the replay the article on http found, 2026-11-19.
    expect(sign({ target: '/invite' })).not.toBe(base);
    expect(sign({ target: '/gen?model=small' })).not.toBe(base);
    expect(sign({ method: 'PUT' })).not.toBe(base);
    // A captured batch cannot be replayed as another one of the same column.
    expect(sign({ offset: 4, total: 8 })).not.toBe(sign({ total: 8 }));
    expect(sign({ total: 8 })).not.toBe(base);
    // …and it is a function of those alone.
    expect(sign()).toBe(base);
  });

  it('signs the target that goes on the wire, not the src as written', () => {
    const headers = contractHeaders(
      {
        src: 'http://127.0.0.1:1/gen?',
        count: 4,
        offset: 0,
        total: 4,
        seed: 'seed1',
        secret: SECRET,
        onError: 'fail',
        timeoutMs: 1000,
        nowMs: 1_786_000_000_000,
      },
      'body',
    );
    expect(headers['X-TDC-Signature']).toBe(
      signRequest(SECRET, 'POST', '/gen', '1786000000', 'seed1', 4, 0, 4, 'body'),
    );
  });

  it('is absent when the config declares no secret', () => {
    const headers = contractHeaders(
      { src: 'http://127.0.0.1:1/x', count: 1, onError: 'fail', timeoutMs: 1000 },
      '',
    );
    expect(headers['X-TDC-Signature']).toBeUndefined();
    expect(headers['X-TDC-Timestamp']).toBeUndefined();
  });
});

describe('where the secret comes from', () => {
  it('reads the environment', () => {
    expect(resolveHttpSecret('env:TDC_TEST_SECRET', '.', { TDC_TEST_SECRET: ' s3cret \n' })).toBe(
      's3cret',
    );
  });

  it('says so when the variable is unset', () => {
    expect(() => resolveHttpSecret('env:TDC_ABSENT', '.', {})).toThrow(HttpSecretError);
  });

  it('takes a literal as itself', () => {
    expect(resolveHttpSecret('  plain-value  ', '.')).toBe('plain-value');
  });

  it('refuses an empty secret whatever its spelling', () => {
    expect(() => resolveHttpSecret('', '.')).toThrow(HttpSecretError);
    expect(() => resolveHttpSecret('env:X', '.', { X: '   ' })).toThrow(HttpSecretError);
  });
});
