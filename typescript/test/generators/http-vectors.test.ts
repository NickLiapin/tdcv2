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
      timestamp: string;
      seed: string;
      count: number;
      body: string;
      signature: string;
    }[];
  };
  derivedSeed: { vectors: { envSeed: string; sequence: string; derived: string }[] };
};

describe('X-TDC-Signature', () => {
  it.each(VECTORS.signature.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    expect(signRequest(v.secret, v.timestamp, v.seed, v.count, v.body)).toBe(v.signature);
  });

  it('has a vector for every part of the message', () => {
    // A vector file that pins one request pins nothing: the point is that each
    // field reaches the hash. These four differ from the canonical request in
    // exactly one field each, so a port that dropped a field from the message
    // would match the first vector and fail one of these.
    const signatures = new Set(VECTORS.signature.vectors.map((v) => v.signature));
    expect(signatures.size).toBe(VECTORS.signature.vectors.length);
    expect(VECTORS.signature.vectors.length).toBeGreaterThanOrEqual(6);
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
