/**
 * The two numbers a service recomputes, held to `fixtures/cross-language/http-vectors.json`.
 *
 * A service checks ONE signature and reads ONE seed. It cannot tell which of the
 * five runtimes sent the request, so both values are the wire contract rather
 * than an implementation detail — and until this file existed the signature was
 * pinned by value in two implementations and the derived seed in one. A port
 * could have computed something else entirely and four suites would have stayed
 * green; the failure would have surfaced as 401s in a user's own service.
 *
 * The other four read the same JSON. If any of them drifts, its own suite fails
 * on the same line as this one.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dotSegmentOf, httpTarget } from '../../src/generators/http-target.js';
import { httpSeedFor, signRequest } from '../../src/generators/http.js';

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  readFileSync(
    resolve(here, '..', '..', '..', 'fixtures', 'cross-language', 'http-vectors.json'),
    'utf8',
  ),
) as {
  signature: {
    vectors: {
      name: string;
      secret: string;
      method: string;
      target: string;
      timestamp: string;
      seed: string;
      count: number;
      offset: number;
      total: number;
      body: string;
      signature: string;
    }[];
  };
  target: { vectors: { name: string; src: string; target: string; url: string }[] };
  derivedSeed: { vectors: { envSeed: string; sequence: string; derived: string }[] };
};

describe('X-TDC-Signature', () => {
  it.each(VECTORS.signature.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(
      signRequest(
        v.secret,
        v.method,
        v.target,
        v.timestamp,
        v.seed,
        v.count,
        v.offset,
        v.total,
        v.body,
      ),
    ).toBe(v.signature);
  });

  it('has a vector for every part of the message', () => {
    // A vector file that pins one request pins nothing: the point is that each
    // field reaches the hash. The others differ from the canonical request in
    // exactly one field each, so a port that dropped a field from the message
    // would match the first vector and fail one of these.
    const signatures = new Set(VECTORS.signature.vectors.map((v) => v.signature));
    expect(signatures.size).toBe(VECTORS.signature.vectors.length);
    expect(VECTORS.signature.vectors.length).toBeGreaterThanOrEqual(6);
  });
});

describe('the signed target', () => {
  it.each(VECTORS.target.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(httpTarget(v.src)).toEqual({ url: v.url, target: v.target });
  });

  it('leaves a target already in its form untouched', () => {
    // The property the rebuilt URL relies on: what the rule produced, it
    // produces again — so a client handed it has nothing left to change.
    for (const v of VECTORS.target.vectors) {
      expect(httpTarget(v.url)).toEqual({ url: v.url, target: v.target });
    }
  });

  it('finds a dot segment however it is spelled', () => {
    expect(dotSegmentOf('http://h/a/../b')).toBe('..');
    expect(dotSegmentOf('http://h/./b')).toBe('.');
    expect(dotSegmentOf('http://h/a/%2e%2E')).toBe('..');
    expect(dotSegmentOf('http://h/a/.%2e/b?x=..')).toBe('..');
    expect(dotSegmentOf('http://h/a..b/.x/x.?q=/../')).toBeUndefined();
  });
});

describe('X-TDC-Seed', () => {
  it.each(VECTORS.derivedSeed.vectors.map((v) => [`${v.envSeed}|${v.sequence}`, v] as const))(
    'derives %s',
    (_name, v) => {
      expect(httpSeedFor(v.envSeed, v.sequence)).toBe(v.derived);
    },
  );

  it('gives two sequences of one run different seeds', () => {
    // The reason the value is derived rather than passed through: a service that
    // generates from the seed would otherwise hand back two identical columns.
    expect(httpSeedFor('run', 'A')).not.toBe(httpSeedFor('run', 'B'));
  });
});
