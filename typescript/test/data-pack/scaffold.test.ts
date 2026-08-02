import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CANONICAL_LOCALES, RESERVED_BUCKETS, directionOf } from '../../src/data-pack/locales.js';

const here = dirname(fileURLToPath(import.meta.url));
const packsDir = resolve(here, '..', '..', '..', 'data', 'packs');

describe('locale folder scaffold', () => {
  it('has a manifest for every canonical locale, with the right direction', () => {
    for (const code of CANONICAL_LOCALES) {
      const manifest = join(packsDir, code, '_locale.json');
      expect(existsSync(manifest), `${code} manifest missing`).toBe(true);
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        code: string;
        direction: string;
      };
      expect(parsed.code, code).toBe(code);
      expect(parsed.direction, code).toBe(directionOf(code));
    }
  });

  it('has no top-level folder that is not a locale, reserved bucket, or countries/', () => {
    for (const name of readdirSync(packsDir)) {
      if (!statSync(join(packsDir, name)).isDirectory()) continue;
      // `countries/` is the physical grouping folder for country generators.
      const known =
        CANONICAL_LOCALES.has(name) || RESERVED_BUCKETS.has(name) || name === 'countries';
      expect(known, `unexpected top-level folder "${name}"`).toBe(true);
    }
  });
});
