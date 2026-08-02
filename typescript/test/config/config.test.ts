import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  globalConfigPath,
  findProjectConfig,
  loadConfig,
} from '../../src/config/config.js';

/**
 * The config cascade is the foundation of pack resolution, so its rules are
 * pinned precisely: paths accumulate low→high, locale takes the highest level,
 * paths in a file resolve against that file's directory, and a malformed config
 * is a loud error rather than a silent skip.
 */

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tdccfg-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('globalConfigPath', () => {
  it('uses XDG on linux/mac', () => {
    const p = globalConfigPath({ cwd: '.', platform: 'linux', home: '/home/x', env: {} });
    expect(p).toBe('/home/x/.config/tdcv2/config.json');
  });

  it('honours XDG_CONFIG_HOME', () => {
    const p = globalConfigPath({
      cwd: '.',
      platform: 'linux',
      home: '/home/x',
      env: { XDG_CONFIG_HOME: '/custom/cfg' },
    });
    expect(p).toBe('/custom/cfg/tdcv2/config.json');
  });

  it('uses APPDATA on windows', () => {
    const p = globalConfigPath({
      cwd: '.',
      platform: 'win32',
      home: 'C:\\Users\\x',
      env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' },
    });
    expect(p).toBe(join('C:\\Users\\x\\AppData\\Roaming', 'tdcv2', 'config.json'));
  });
});

describe('findProjectConfig', () => {
  it('finds the nearest config walking up', () => {
    const root = tree({
      'tdcv2.config.json': '{}',
      'a/b/c/keep.txt': 'x',
    });
    expect(findProjectConfig(join(root, 'a', 'b', 'c'))).toBe(join(root, 'tdcv2.config.json'));
  });

  it('prefers a closer config over a further one', () => {
    const root = tree({
      'tdcv2.config.json': '{}',
      'a/tdcv2.config.json': '{}',
      'a/b/keep.txt': 'x',
    });
    expect(findProjectConfig(join(root, 'a', 'b'))).toBe(join(root, 'a', 'tdcv2.config.json'));
  });

  it('returns undefined when there is none', () => {
    const root = tree({ 'keep.txt': 'x' });
    expect(findProjectConfig(root)).toBeUndefined();
  });
});

describe('loadConfig — cascade', () => {
  // A home dir holding the global config, kept out of the project tree.
  function withGlobal(content: string): { home: string; env: NodeJS.ProcessEnv } {
    const home = tree({ '.config/tdcv2/config.json': content });
    return { home, env: {} };
  }

  it('accumulates dataPaths low→high: global, then project, then flags', () => {
    const { home, env } = withGlobal('{ "dataPaths": ["gpacks"] }');
    const proj = tree({ 'tdcv2.config.json': '{ "dataPaths": ["ppacks"] }', 'sub/x.txt': 'x' });
    const cfg = loadConfig({
      cwd: join(proj, 'sub'),
      home,
      env,
      platform: 'linux',
      flagDataPaths: ['flagpacks'],
    });
    expect(cfg.dataPaths).toEqual([
      join(home, '.config/tdcv2/gpacks'),
      join(proj, 'ppacks'),
      resolve(join(proj, 'sub'), 'flagpacks'),
    ]);
  });

  it('resolves file dataPaths relative to the config file, flags relative to cwd', () => {
    const proj = tree({ 'cfgdir/tdcv2.config.json': '{ "dataPaths": ["./packs"] }' });
    const cfg = loadConfig({
      cwd: join(proj, 'cfgdir'),
      home: tree({}),
      env: {},
      platform: 'linux',
    });
    expect(cfg.dataPaths).toEqual([join(proj, 'cfgdir', 'packs')]);
  });

  it('locale takes the highest level: flag > project > global', () => {
    const { home, env } = withGlobal('{ "locale": "de" }');
    const proj = tree({ 'tdcv2.config.json': '{ "locale": "en" }' });

    expect(loadConfig({ cwd: proj, home, env, platform: 'linux' }).locale).toBe('en');
    expect(loadConfig({ cwd: proj, home, env, platform: 'linux', flagLocale: 'ru' }).locale).toBe(
      'ru',
    );
  });

  it('absolute dataPaths are taken as-is', () => {
    const proj = tree({ 'tdcv2.config.json': '{ "dataPaths": ["/abs/packs"] }' });
    const cfg = loadConfig({ cwd: proj, home: tree({}), env: {}, platform: 'linux' });
    expect(cfg.dataPaths).toEqual(['/abs/packs']);
  });

  it('is empty when there is no config anywhere', () => {
    const cfg = loadConfig({ cwd: tree({}), home: tree({}), env: {}, platform: 'linux' });
    expect(cfg.dataPaths).toEqual([]);
    expect(cfg.locale).toBeUndefined();
    expect(cfg.packStore).toBeUndefined();
    expect(cfg.packStoreSource).toBeUndefined();
    expect(cfg.sources).toEqual([]);
  });

  it('resolves packStore relative to its config file and records the source', () => {
    const proj = tree({ 'cfgdir/tdcv2.config.json': '{ "packStore": "./tdcv2-packs" }' });
    const configPath = join(proj, 'cfgdir', 'tdcv2.config.json');
    const cfg = loadConfig({
      cwd: join(proj, 'cfgdir'),
      home: tree({}),
      env: {},
      platform: 'linux',
    });
    expect(cfg.packStore).toBe(join(proj, 'cfgdir', 'tdcv2-packs'));
    expect(cfg.packStoreSource).toBe(configPath);
  });

  it('project packStore overrides global, and the source points at the winner', () => {
    const { home, env } = withGlobal('{ "packStore": "/global/store" }');
    const proj = tree({ 'tdcv2.config.json': '{ "packStore": "/project/store" }' });
    const cfg = loadConfig({ cwd: proj, home, env, platform: 'linux' });
    expect(cfg.packStore).toBe('/project/store');
    expect(cfg.packStoreSource).toBe(join(proj, 'tdcv2.config.json'));
  });

  it('a global packStore is used (and sourced) when the project sets none', () => {
    const { home, env } = withGlobal('{ "packStore": "/global/store" }');
    const proj = tree({ 'tdcv2.config.json': '{ "locale": "en" }' });
    const cfg = loadConfig({ cwd: proj, home, env, platform: 'linux' });
    expect(cfg.packStore).toBe('/global/store');
    expect(cfg.packStoreSource).toBe(join(home, '.config/tdcv2/config.json'));
  });

  it('rejects an empty packStore', () => {
    const proj = tree({ 'tdcv2.config.json': '{ "packStore": "" }' });
    expect(() => loadConfig({ cwd: proj, home: tree({}), env: {}, platform: 'linux' })).toThrow(
      /packStore/,
    );
  });
});

describe('loadConfig — malformed config is a loud error', () => {
  const load = (content: string): void => {
    const proj = tree({ 'tdcv2.config.json': content });
    loadConfig({ cwd: proj, home: tree({}), env: {}, platform: 'linux' });
  };

  it('rejects invalid JSON', () => {
    expect(() => {
      load('{ not json');
    }).toThrow(ConfigError);
  });

  it('rejects a non-object top level', () => {
    expect(() => {
      load('[1,2,3]');
    }).toThrow(/must be a JSON object/);
  });

  it('rejects dataPaths that is not an array', () => {
    expect(() => {
      load('{ "dataPaths": "packs" }');
    }).toThrow(/must be an array/);
  });

  it('rejects a non-string dataPaths entry', () => {
    expect(() => {
      load('{ "dataPaths": [123] }');
    }).toThrow(/non-empty strings/);
  });

  it('rejects an empty locale', () => {
    expect(() => {
      load('{ "locale": "" }');
    }).toThrow(/non-empty string/);
  });
});
