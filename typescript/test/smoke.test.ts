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

  it('keeps the DSL ceiling separate from the package version', () => {
    // They moved together once, so every patch release raised the ceiling here
    // while the four ports stayed where the language was — and the same config
    // ran in one implementation and was refused by four. The ceiling rises only
    // when the DSL gains something, and then in all five at once.
    expect(SUPPORTED_DSL_VERSION).toBe('0.1.0');
    expect(compareVersions(SUPPORTED_DSL_VERSION, VERSION)).not.toBe(1);
  });

  it('compares document versions numerically', () => {
    // Against SUPPORTED_DSL_VERSION, which is what the validator compares a
    // `<tdc version=>` to — not against VERSION, the package number. This used
    // to read VERSION, so the assertion held only while the two happened to be
    // near each other, and releasing 0.2.0 broke a test about a document
    // dialect that had not changed at all.
    expect(compareVersions('0.01', '0.1.0')).toBe(0);
    expect(compareVersions('0.2', SUPPORTED_DSL_VERSION)).toBe(1);
    expect(compareVersions('0.0.9', SUPPORTED_DSL_VERSION)).toBe(-1);
  });
});
