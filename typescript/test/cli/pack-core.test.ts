import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  INSTALLED_FILE,
  PackError,
  addDataPath,
  bundleOwnedPaths,
  findBundle,
  installedBundleIds,
  isPathInside,
  parseIndex,
  readInstalled,
  removeDataPath,
  removeDataPathsInside,
  verifySha256,
  withBundle,
  withoutBundle,
  writeInstalled,
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

describe('the store record', () => {
  const entry = (id: string, paths: string[]) => ({
    id,
    paths,
    version: '',
    sha256: 'aa',
    files: 2,
  });

  it('is empty for a missing store', () => {
    expect(installedBundleIds(join(tmp(), 'nope'))).toEqual([]);
  });

  it('round-trips through the dotfile, ids sorted', () => {
    const store = tmp();
    writeInstalled(store, {
      schemaVersion: 1,
      bundles: [entry('usa', ['countries/usa']), entry('en', ['en'])],
    });
    expect(installedBundleIds(store)).toEqual(['en', 'usa']);
    expect(readInstalled(store).bundles[0]?.paths).toEqual(['en']);
    // The name matters: the store is a scan root, and the loader skips ignored
    // NAMES, so anything without a leading dot here would load as a pack.
    expect(INSTALLED_FILE.startsWith('.')).toBe(true);
    expect(readFileSync(join(store, INSTALLED_FILE), 'utf8').endsWith('\n')).toBe(true);
  });

  it('a tree nobody recorded is not "installed"', () => {
    const store = tmp();
    mkdirSync(join(store, 'en', 'person'), { recursive: true });
    expect(installedBundleIds(store)).toEqual([]);
  });

  it('refuses a record that claims a path outside the store', () => {
    const store = tmp();
    writeFileSync(
      join(store, INSTALLED_FILE),
      JSON.stringify({ schemaVersion: 1, bundles: [entry('evil', ['../../etc'])] }),
    );
    expect(() => readInstalled(store)).toThrow(/outside the store/);
  });

  it('refuses a malformed record rather than reporting an empty store', () => {
    const store = tmp();
    writeFileSync(join(store, INSTALLED_FILE), '{ not json');
    expect(() => readInstalled(store)).toThrow(PackError);
  });

  it('refuses a record from a newer tdcv2', () => {
    const store = tmp();
    writeFileSync(join(store, INSTALLED_FILE), JSON.stringify({ schemaVersion: 2, bundles: [] }));
    expect(() => readInstalled(store)).toThrow(/newer tdcv2/);
  });

  it('withBundle replaces the same id; withoutBundle drops it', () => {
    const one = withBundle({ schemaVersion: 1, bundles: [] }, entry('en', ['en']));
    const again = withBundle(one, { ...entry('en', ['en']), files: 9 });
    expect(again.bundles).toHaveLength(1);
    expect(again.bundles[0]?.files).toBe(9);
    expect(withoutBundle(again, 'en').bundles).toEqual([]);
  });
});

describe('bundleOwnedPaths', () => {
  it('claims the one subtree a bundle fills', () => {
    expect(bundleOwnedPaths(['ru/person/lastName.txt', 'ru/city/name.txt'])).toEqual(['ru']);
  });

  it('claims the country, never the shared countries/ folder above it', () => {
    expect(
      bundleOwnedPaths(['countries/russia/docs/inn.txt', 'countries/russia/tax/x.txt']),
    ).toEqual(['countries/russia']);
  });

  it('claims each top-level entry when the files share no parent', () => {
    expect(bundleOwnedPaths(['en/a.txt', 'countries/usa/b.txt'])).toEqual(['countries', 'en']);
  });

  it('claims a lone file at the root as itself', () => {
    expect(bundleOwnedPaths(['loose.txt'])).toEqual(['loose.txt']);
  });

  it('claims no more than the bundle actually fills', () => {
    // A one-file country stub owns the folder holding that file, not the whole
    // country — the answer follows the files, so removal can never take more
    // than the bundle brought.
    expect(bundleOwnedPaths(['countries/andorra/docs/nid.txt'])).toEqual([
      'countries/andorra/docs',
    ]);
  });

  it('is empty for no files', () => {
    expect(bundleOwnedPaths([])).toEqual([]);
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

describe('addDataPath', () => {
  const writeCfg = (dir: string, obj: unknown): string => {
    const p = join(dir, 'tdcv2.config.json');
    writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  const read = (p: string): { dataPaths?: string[]; packStore?: string; locale?: string } =>
    JSON.parse(readFileSync(p, 'utf8')) as { dataPaths?: string[]; packStore?: string };

  it('adds the store as a relative path and keeps other settings', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { packStore: './tdcv2-packs', locale: 'en' });

    const { added, stored } = addDataPath(cfg, join(dir, 'tdcv2-packs'));
    expect(added).toBe(true);
    expect(stored).toBe('./tdcv2-packs');
    const after = read(cfg);
    expect(after.dataPaths).toEqual(['./tdcv2-packs']);
    expect(after.packStore).toBe('./tdcv2-packs'); // untouched
    expect(after.locale).toBe('en');
  });

  it('is idempotent — a second bundle adds no second entry', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { packStore: './p' });
    addDataPath(cfg, join(dir, 'p'));
    const { added } = addDataPath(cfg, join(dir, 'p'));
    expect(added).toBe(false);
    expect(read(cfg).dataPaths).toEqual(['./p']);
  });

  it('de-dupes an absolute path already present as relative', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { dataPaths: ['./p'], packStore: './p' });
    const { added } = addDataPath(cfg, join(dir, 'p')); // same target, absolute input
    expect(added).toBe(false);
  });

  it('throws on a malformed config', () => {
    const dir = tmp();
    const p = join(dir, 'tdcv2.config.json');
    writeFileSync(p, '{ not json');
    expect(() => addDataPath(p, join(dir, 'p'))).toThrow(PackError);
  });
});

describe('removeDataPath', () => {
  const writeCfg = (dir: string, obj: unknown): string => {
    const p = join(dir, 'tdcv2.config.json');
    writeFileSync(p, JSON.stringify(obj, null, 2));
    return p;
  };
  const read = (p: string): { dataPaths?: string[] } =>
    JSON.parse(readFileSync(p, 'utf8')) as { dataPaths?: string[] };

  it('drops the store and reports removed; the rest is untouched', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { packStore: './p', dataPaths: ['./p', './my-own-lists'] });
    const { removed } = removeDataPath(cfg, join(dir, 'p'));
    expect(removed).toBe(true);
    expect(read(cfg).dataPaths).toEqual(['./my-own-lists']);
  });

  it('matches an absolute-vs-relative entry (removes either form)', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { dataPaths: ['./p'] }); // relative
    expect(removeDataPath(cfg, join(dir, 'p')).removed).toBe(true); // absolute
    expect(read(cfg).dataPaths).toEqual([]);
  });

  it('is a no-op when the store is not registered', () => {
    const dir = tmp();
    const cfg = writeCfg(dir, { dataPaths: ['./elsewhere'] });
    expect(removeDataPath(cfg, join(dir, 'p')).removed).toBe(false);
    expect(read(cfg).dataPaths).toEqual(['./elsewhere']);
  });
});

describe('removeDataPathsInside', () => {
  it('drops the per-bundle entries and keeps the store and everything outside it', () => {
    const dir = tmp();
    const cfg = join(dir, 'tdcv2.config.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        packStore: './p',
        dataPaths: ['./p/en/packs', './p/usa/packs', './p', './my-own-lists'],
      }),
    );
    expect(removeDataPathsInside(cfg, join(dir, 'p'))).toBe(2);
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual(['./p', './my-own-lists']);
  });
});
