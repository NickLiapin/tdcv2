import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SUPPORTED_DSL_VERSION, VERSION, compareVersions } from '../src/index.js';

const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
) as { version: string };

describe('package smoke test', () => {
  // Read rather than repeated. The assertion used to name the version outright, so
  // it agreed with itself and with nothing else: `npm version` moved package.json
  // and this test went on passing while `tdcv2 --version` reported the old number.
  it('exports a version string matching package.json', () => {
    expect(VERSION).toBe(packageJson.version);
  });

  it('VERSION conforms to semver-like shape', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('uses the runtime version as the current DSL compatibility ceiling', () => {
    expect(SUPPORTED_DSL_VERSION).toBe(VERSION);
  });

  it('compares document versions numerically', () => {
    expect(compareVersions('0.01', '0.1.0')).toBe(0);
    expect(compareVersions('0.2', VERSION)).toBe(1);
    expect(compareVersions('0.0.9', VERSION)).toBe(-1);
  });
});
