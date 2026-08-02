import { describe, expect, it } from 'vitest';

import { SUPPORTED_DSL_VERSION, VERSION, compareVersions } from '../src/index.js';

describe('package smoke test', () => {
  it('exports a version string matching package.json', () => {
    expect(VERSION).toBe('0.1.0');
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
