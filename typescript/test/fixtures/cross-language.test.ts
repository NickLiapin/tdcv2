import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { distributeByPercent } from '../../src/distribution/hamilton.js';
import { TDC } from '../../src/index.js';
import { createPrng } from '../../src/prng/prng.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const crossFixturesDir = resolve(repoRoot, 'fixtures', 'cross-language');

interface Manifest {
  readonly schemaVersion: number;
  readonly fixedNow: string;
  readonly vectorFiles: {
    readonly prng: string;
    readonly hamilton: string;
  };
  readonly runtimeFixtures: readonly RuntimeFixture[];
}

interface RuntimeFixture {
  readonly name: string;
  readonly source: string;
  readonly expected: string;
  readonly description: string;
}

interface PrngVectorsFile {
  readonly schemaVersion: number;
  readonly algorithm: string;
  readonly valuesPerSeed: number;
  readonly vectors: readonly PrngVector[];
}

interface PrngVector {
  readonly seed: string;
  readonly values: readonly number[];
}

interface HamiltonVectorsFile {
  readonly schemaVersion: number;
  readonly algorithm: string;
  readonly vectors: readonly HamiltonVector[];
}

interface HamiltonVector {
  readonly name: string;
  readonly seed: string;
  readonly count: number;
  readonly values: readonly string[];
  readonly percents: readonly number[];
  readonly expected?: readonly string[];
  readonly expectedPrefix?: readonly string[];
  readonly expectedCounts?: Readonly<Record<string, number>>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const manifest = readJson(resolve(crossFixturesDir, 'manifest.json')) as Manifest;
const prngVectors = readJson(
  resolve(crossFixturesDir, manifest.vectorFiles.prng),
) as PrngVectorsFile;
const hamiltonVectors = readJson(
  resolve(crossFixturesDir, manifest.vectorFiles.hamilton),
) as HamiltonVectorsFile;
const fixedNow = Date.parse(manifest.fixedNow);

describe('cross-language fixture metadata', () => {
  it('uses the expected manifest schema and fixed clock', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(Number.isNaN(fixedNow)).toBe(false);
    expect(prngVectors.schemaVersion).toBe(1);
    expect(hamiltonVectors.schemaVersion).toBe(1);
  });
});

describe('cross-language PRNG vectors', () => {
  it.each(prngVectors.vectors)('seed "$seed" matches shared golden values', ({ seed, values }) => {
    expect(values).toHaveLength(prngVectors.valuesPerSeed);
    const prng = createPrng(seed);
    for (const expected of values) {
      expect(prng()).toBe(expected);
    }
  });
});

describe('cross-language Hamilton vectors', () => {
  it.each(hamiltonVectors.vectors)('$name matches shared exact-distribution output', (vector) => {
    const out = distributeByPercent({
      count: vector.count,
      values: vector.values,
      percents: vector.percents,
      prng: createPrng(vector.seed),
    });

    expect(out).toHaveLength(vector.count);
    if (vector.expected) expect(out).toEqual(vector.expected);
    if (vector.expectedPrefix) {
      expect(out.slice(0, vector.expectedPrefix.length)).toEqual(vector.expectedPrefix);
    }
    for (const [value, expectedCount] of Object.entries(vector.expectedCounts ?? {})) {
      expect(out.filter((actual) => actual === value)).toHaveLength(expectedCount);
    }
  });
});

describe('cross-language runtime fixtures', () => {
  it.each(manifest.runtimeFixtures)('$name renders byte-identical expected output', (fixture) => {
    const source = resolve(crossFixturesDir, fixture.source);
    const expected = readFileSync(resolve(crossFixturesDir, fixture.expected), 'utf8');
    // mode="memory" (Engine 1) is the cross-language reference: these baselines
    // are the byte-for-byte contract every language implementation matches.
    // Disk is the user default, but the canonical oracle stays Engine 1.
    const actual = new TDC({ configFile: source, now: fixedNow, mode: 'memory' }).toString();

    expect(actual).toBe(expected);
  });
});
