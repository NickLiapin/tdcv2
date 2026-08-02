import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PackError,
  bundlePacksRoot,
  findBundle,
  installedBundleIds,
  isPathInside,
  parseIndex,
  registerBundleInConfig,
  unregisterBundleFromConfig,
  verifySha256,
} from '../../src/cli/pack-core.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tdcpack-'));

const VALID = JSON.stringify({
  schemaVersion: 1,
  description: 'test',
  bundles: [
    {
      id: 'en',
      name: 'English (language)',
      description: 'US data',
      file: 'bundles/en.zip',
      bytes: 100,
      sha256: 'ABCD',
      locale: 'en',
      contents: ['packs/en'],
    },
  ],
});

describe('parseIndex', () => {
  it('parses a valid index and lower-cases the hash', () => {
    const idx = parseIndex(VALID);
    expect(idx.schemaVersion).toBe(1);
    expect(idx.bundles).toHaveLength(1);
    expect(idx.bundles[0]?.id).toBe('en');
    expect(idx.bundles[0]?.sha256).toBe('abcd');
    expect(idx.bundles[0]?.contents).toEqual(['packs/en']);
  });

  it('rejects a non-object', () => {
    expect(() => parseIndex('[]')).toThrow(PackError);
    expect(() => parseIndex('42')).toThrow(PackError);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseIndex('{not json')).toThrow(PackError);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() => parseIndex(JSON.stringify({ schemaVersion: 2, bundles: [] }))).toThrow(
      /unsupported schemaVersion 2/,
    );
  });

  it('rejects a missing schemaVersion', () => {
    expect(() => parseIndex(JSON.stringify({ bundles: [] }))).toThrow(PackError);
  });

  it('rejects bundles that are not an array', () => {
    expect(() => parseIndex(JSON.stringify({ schemaVersion: 1, bundles: {} }))).toThrow(PackError);
  });

  it('rejects a bundle missing a required field', () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      bundles: [{ id: 'x', name: 'X', file: 'f.zip', bytes: 1 }], // no sha256
    });
    expect(() => parseIndex(bad)).toThrow(/sha256/);
  });

  it('rejects a negative byte count', () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      bundles: [{ id: 'x', name: 'X', file: 'f.zip', bytes: -1, sha256: 'a' }],
    });
    expect(() => parseIndex(bad)).toThrow(/bytes/);
  });
});

describe('findBundle', () => {
  it('finds by id', () => {
    expect(findBundle(parseIndex(VALID), 'en').name).toBe('English (language)');
  });

  it('throws listing what is available for an unknown id', () => {
    expect(() => findBundle(parseIndex(VALID), 'nope')).toThrow(/Available: en/);
  });
});

describe('verifySha256', () => {
  it('accepts a matching hash and rejects a mismatch', () => {
    const data = new TextEncoder().encode('hello');
    const good = createHash('sha256').update(data).digest('hex');
    expect(verifySha256(data, good)).toBe(true);
    expect(verifySha256(data, good.toUpperCase())).toBe(true); // case-insensitive
    expect(verifySha256(data, 'deadbeef')).toBe(false);
  });
});

describe('installedBundleIds', () => {
  it('is empty for a missing store', () => {
    expect(installedBundleIds(join(tmp(), 'nope'))).toEqual([]);
  });

  it('lists only folders that carry a packs/ subdir', () => {
    const store = tmp();
    mkdirSync(join(store, 'en', 'packs'), { recursive: true });
    mkdirSync(join(store, 'usa', 'packs'), { recursive: true });
    mkdirSync(join(store, 'stray'), { recursive: true }); // no packs/ → ignored
    expect(installedBundleIds(store)).toEqual(['en', 'usa']);
  });
});

describe('isPathInside', () => {
  it('accepts a nested path and the root itself', () => {
    expect(isPathInside('/a/b/c', '/a/b')).toBe(true);
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
  });

  it('rejects an escaping path (zip-slip)', () => {
    expect(isPathInside('/a/b/../../etc/passwd', '/a/b')).toBe(false);
    expect(isPathInside('/other', '/a/b')).toBe(false);
  });
});

describe('registerBundleInConfig', () => {
  const writeCfg = (dir: string, obj: unknown): string => {
    const p = join(dir, 'tdcv2.config.json');
    writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  const read = (p: string): { dataPaths?: string[]; packStore?: string; locale?: string } =>
    JSON.parse(readFileSync(p, 'utf8')) as { dataPaths?: string[]; packStore?: string };

  it('adds the pack root as a relative path and keeps other settings', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { packStore: './tdcv2-packs', locale: 'en' });
    const root = bundlePacksRoot(join(dir, 'tdcv2-packs'), 'en');

    const { added, stored } = registerBundleInConfig(cfg, root);
    expect(added).toBe(true);
    expect(stored).toBe('./tdcv2-packs/en/packs');
    const after = read(cfg);
    expect(after.dataPaths).toEqual(['./tdcv2-packs/en/packs']);
    expect(after.packStore).toBe('./tdcv2-packs'); // untouched
    expect(after.locale).toBe('en');
  });

  it('is idempotent — a second register adds nothing', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { packStore: './p' });
    const root = bundlePacksRoot(join(dir, 'p'), 'en');
    registerBundleInConfig(cfg, root);
    const { added } = registerBundleInConfig(cfg, root);
    expect(added).toBe(false);
    expect(read(cfg).dataPaths).toEqual(['./p/en/packs']);
  });

  it('de-dupes an absolute path already present as relative', () => {
    const dir = tmp();
    const root = bundlePacksRoot(join(dir, 'p'), 'en');
    const cfg = writeCfg(dir, { dataPaths: ['./p/en/packs'], packStore: './p' });
    const { added } = registerBundleInConfig(cfg, root); // same target, absolute input
    expect(added).toBe(false);
  });

  it('throws on a malformed config', () => {
    const dir = tmp();
    const p = join(dir, 'tdcv2.config.json');
    writeFileSync(p, '{ not json');
    expect(() => registerBundleInConfig(p, join(dir, 'p'))).toThrow(PackError);
  });
});

describe('unregisterBundleFromConfig', () => {
  const writeCfg = (dir: string, obj: unknown): string => {
    const p = join(dir, 'tdcv2.config.json');
    writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  const read = (p: string): { dataPaths?: string[] } =>
    JSON.parse(readFileSync(p, 'utf8')) as { dataPaths?: string[] };

  it('drops the pack root and reports removed; the rest is untouched', () => {
    const dir = tmp();
    const root = bundlePacksRoot(join(dir, 'p'), 'en');
    const cfg = writeCfg(dir, {
      packStore: './p',
      dataPaths: ['./p/en/packs', './p/usa/packs'],
    });
    const { removed } = unregisterBundleFromConfig(cfg, root);
    expect(removed).toBe(true);
    expect(read(cfg).dataPaths).toEqual(['./p/usa/packs']); // only en's root gone
  });

  it('matches an absolute-vs-relative entry (removes either form)', () => {
    const dir = tmp();
    const root = bundlePacksRoot(join(dir, 'p'), 'en'); // absolute
    const cfg = writeCfg(dir, { dataPaths: ['./p/en/packs'] }); // relative
    expect(unregisterBundleFromConfig(cfg, root).removed).toBe(true);
    expect(read(cfg).dataPaths).toEqual([]);
  });

  it('is a no-op when the root is not registered', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { dataPaths: ['./p/usa/packs'] });
    const { removed } = unregisterBundleFromConfig(cfg, bundlePacksRoot(join(dir, 'p'), 'en'));
    expect(removed).toBe(false);
    expect(read(cfg).dataPaths).toEqual(['./p/usa/packs']);
  });
});
