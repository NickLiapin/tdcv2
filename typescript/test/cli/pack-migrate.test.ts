/**
 * Upgrading a store that was written by an older tdcv2.
 *
 * Before the flat store, `pack add` unpacked to `<store>/<id>/packs/…` and wrote
 * one `dataPaths` entry per bundle. Anyone who installed a pack has that on disk
 * and in their config, and neither `list` nor `remove` can read it any more — so
 * the first `tdcv2 pack` after the upgrade has to move it, in place, and say so.
 * These tests are the ones that stand between an existing user and a store they
 * would have to delete and download again.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { runPack } from '../../src/cli/pack.js';
import { legacyBundleIds, migrateStore, readInstalled } from '../../src/cli/pack-core.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tdcmigrate-'));

/** Write a file, creating its folders. */
function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

interface OldProject {
  readonly dir: string;
  readonly cfg: string;
  readonly store: string;
}

/**
 * A project as the old `pack add ru russia` left it: two bundle folders, each
 * with its own `packs/` root, and two `dataPaths` entries pointing inside them.
 */
function oldProject(extra: Record<string, string> = {}): OldProject {
  const dir = tmp();
  const store = join(dir, 'tdcv2-packs');
  const cfg = join(dir, 'tdcv2.config.json');
  put(join(store, 'ru/packs/ru/person/lastName.txt'), '---\nlocale: ru\n---\nИванов\n');
  put(join(store, 'ru/packs/ru/city/name.txt'), '---\nlocale: ru\n---\nОмск\n');
  put(join(store, 'ru/packs/ru/_locale.json'), '{"code":"ru"}\n');
  put(
    join(store, 'russia/packs/countries/russia/docs/inn.txt'),
    '---\naddress: russia.docs.inn\n---\n7707083893\n',
  );
  put(
    join(store, 'russia/packs/countries/russia/bank/bic.txt'),
    '---\naddress: russia.bank.bic\n---\n044525225\n',
  );
  for (const [path, body] of Object.entries(extra)) put(join(store, path), body);
  put(
    cfg,
    `${JSON.stringify(
      {
        packStore: './tdcv2-packs',
        locale: 'ru',
        dataPaths: ['./tdcv2-packs/ru/packs', './tdcv2-packs/russia/packs'],
        keepThis: true,
      },
      null,
      2,
    )}\n`,
  );
  return { dir, cfg, store };
}

const readCfg = (cfg: string): { dataPaths?: string[]; keepThis?: boolean; locale?: string } =>
  JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrateStore', () => {
  it('recognises the old layout and does nothing to a flat store', () => {
    const { store } = oldProject();
    expect(legacyBundleIds(store)).toEqual(['ru', 'russia']);
    const dir = tmp();
    mkdirSync(join(dir, 'ru'), { recursive: true });
    expect(legacyBundleIds(join(dir))).toEqual([]);
  });

  it('moves each tree up, records it, and leaves one dataPaths entry', () => {
    const { cfg, store } = oldProject();

    const result = migrateStore(store, cfg);
    expect(result).toBeDefined();

    // On disk: the address path and nothing above it.
    expect(readFileSync(join(store, 'ru/person/lastName.txt'), 'utf8')).toContain('Иванов');
    expect(existsSync(join(store, 'ru/_locale.json'))).toBe(true); // travels with its locale
    expect(existsSync(join(store, 'countries/russia/docs/inn.txt'))).toBe(true);
    expect(existsSync(join(store, 'ru/packs'))).toBe(false);
    expect(existsSync(join(store, 'russia'))).toBe(false);

    // In the books: who owns what.
    const record = readInstalled(store);
    expect(record.bundles.map((b) => [b.id, b.paths])).toEqual([
      ['ru', ['ru']],
      ['russia', ['countries/russia']],
    ]);
    // Nothing to claim about an archive nobody kept.
    expect(record.bundles[0]?.sha256).toBe('');
    expect(record.bundles[0]?.files).toBe(3);

    // In the config: two per-bundle entries out, the store in, everything else kept.
    const cfgAfter = readCfg(cfg);
    expect(cfgAfter.dataPaths).toEqual(['./tdcv2-packs']);
    expect(cfgAfter.keepThis).toBe(true);
    expect(cfgAfter.locale).toBe('ru');
    expect(result?.droppedDataPaths).toBe(2);
    expect(result?.registered).toBe('./tdcv2-packs');
  });

  it('is a no-op the second time', () => {
    const { cfg, store } = oldProject();
    migrateStore(store, cfg);
    expect(migrateStore(store, cfg)).toBeUndefined();
  });

  it('leaves files that were never pack data where they are, and says so', () => {
    const { cfg, store } = oldProject({ 'ru/sources/lastName.csv': 'Иванов,100\n' });
    const result = migrateStore(store, cfg);
    expect(result?.leftovers).toEqual(['ru/sources/lastName.csv']);
    expect(existsSync(join(store, 'ru/sources/lastName.csv'))).toBe(true);
    expect(existsSync(join(store, 'ru/person/lastName.txt'))).toBe(true);
  });

  it('refuses, moving nothing, when a destination is already taken', () => {
    const { cfg, store } = oldProject();
    // Something already sits where `ru` has to land.
    put(join(store, 'ru/person/lastName.txt'), 'somebody else\n');

    expect(() => migrateStore(store, cfg)).toThrow(/collide/);
    // The old tree is untouched, so the user can look and decide.
    expect(existsSync(join(store, 'ru/packs/ru/person/lastName.txt'))).toBe(true);
    expect(readFileSync(join(store, 'ru/person/lastName.txt'), 'utf8')).toBe('somebody else\n');
    expect(readCfg(cfg).dataPaths).toEqual([
      './tdcv2-packs/ru/packs',
      './tdcv2-packs/russia/packs',
    ]);
  });
});

describe('runPack on an old store', () => {
  it('migrates before it does anything else, and reports on stderr', async () => {
    const { dir, cfg, store } = oldProject();
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });

    const code = await runPack(['remove', 'russia'], {
      cwd: dir,
      home: dir,
      platform: 'linux',
      env: {},
    });
    expect(code).toBe(0);

    expect(err).toContain('used the old per-bundle layout');
    expect(err).toContain('ru: ru/packs → ru (3 files)');
    expect(err).toContain('dropped 2 per-bundle dataPaths entries');

    // And the removal that followed acted on the migrated store.
    expect(existsSync(join(store, 'countries'))).toBe(false);
    expect(existsSync(join(store, 'ru/person/lastName.txt'))).toBe(true);
    expect(readInstalled(store).bundles.map((b) => b.id)).toEqual(['ru']);
    expect(readCfg(cfg).dataPaths).toEqual(['./tdcv2-packs']);
  });
});
