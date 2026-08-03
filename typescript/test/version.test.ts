import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/version.js';

/**
 * The version is declared twice in TypeScript — in `package.json`, which is what
 * npm publishes under, and in `src/version.ts`, which is what the public API and
 * `tdcv2 --version` report. Two declarations drift, and this exact bug class has
 * already cost this project once: Java and C# shipped a hardcoded `0.1.0` while
 * their build files said `0.1.3`, and every test stayed green because the shared
 * fixture only asserted the SHAPE of a version string.
 *
 * The two cannot be collapsed into one without a build step that writes a source
 * file, and a generated file is worse than a test that fails the moment they
 * disagree.
 */
describe('VERSION', () => {
  it('is the version npm publishes under', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version: string;
    };

    expect(VERSION).toBe(manifest.version);
  });
});
