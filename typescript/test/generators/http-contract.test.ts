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

import { contractHeaders, fetchHttpValues, signRequest } from '../../src/generators/http.js';
import { HttpSecretError, resolveHttpSecret } from '../../src/generators/http-secret.js';
import { startService, type ServiceHandle } from '../fixtures/http-service.js';

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

  it('covers the timestamp, the seed, the count and the body', () => {
    const base = signRequest(SECRET, '1786000000', 'seed1', 4, 'body');
    expect(signRequest(SECRET, '1786000001', 'seed1', 4, 'body')).not.toBe(base);
    expect(signRequest(SECRET, '1786000000', 'seed2', 4, 'body')).not.toBe(base);
    expect(signRequest(SECRET, '1786000000', 'seed1', 5, 'body')).not.toBe(base);
    expect(signRequest(SECRET, '1786000000', 'seed1', 4, 'other')).not.toBe(base);
    // Same inputs, same answer — a service can recompute it.
    expect(signRequest(SECRET, '1786000000', 'seed1', 4, 'body')).toBe(base);
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
