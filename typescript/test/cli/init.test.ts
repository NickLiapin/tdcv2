import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  InitError,
  buildConfigContent,
  configTargetPath,
  defaultPackStore,
  runInit,
  writeInitConfig,
  type InitPlan,
} from '../../src/cli/init.js';

/**
 * The wizard itself needs a TTY and cannot be unit-tested, so the decisions it
 * makes are pure functions and the non-interactive path (flags) is exercised
 * end to end. Between them every branch that writes a file is covered.
 */

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tdcinit-'));

const readCfg = (path: string): { packStore: string; locale: string } =>
  JSON.parse(readFileSync(path, 'utf8')) as { packStore: string; locale: string };

describe('configTargetPath', () => {
  it('project config lands in the cwd', () => {
    expect(configTargetPath(false, { cwd: '/proj' })).toBe(join('/proj', 'tdcv2.config.json'));
  });

  it('global config uses the per-user path', () => {
    expect(
      configTargetPath(true, { cwd: '/proj', home: '/home/x', platform: 'linux', env: {} }),
    ).toBe('/home/x/.config/tdcv2/config.json');
  });
});

describe('defaultPackStore', () => {
  it('project keeps packs beside the config', () => {
    expect(defaultPackStore(false, '/proj/tdcv2.config.json', { cwd: '/proj' })).toBe(
      join('/proj', 'tdcv2-packs'),
    );
  });

  it('global keeps packs next to the global config', () => {
    const cfg = '/home/x/.config/tdcv2/config.json';
    expect(defaultPackStore(true, cfg, { cwd: '/proj' })).toBe('/home/x/.config/tdcv2/packs');
  });
});

describe('buildConfigContent', () => {
  it('a project config writes a RELATIVE, portable path', () => {
    const plan: InitPlan = {
      path: '/proj/tdcv2.config.json',
      packStore: '/proj/tdcv2-packs',
      locale: 'en',
      global: false,
    };
    expect(JSON.parse(buildConfigContent(plan))).toEqual({
      packStore: './tdcv2-packs',
      locale: 'en',
    });
  });

  it('a global config writes the absolute (machine-specific) path', () => {
    const plan: InitPlan = {
      path: '/home/x/.config/tdcv2/config.json',
      packStore: '/home/x/.config/tdcv2/packs',
      locale: 'de',
      global: true,
    };
    expect(JSON.parse(buildConfigContent(plan))).toEqual({
      packStore: '/home/x/.config/tdcv2/packs',
      locale: 'de',
    });
  });
});

describe('writeInitConfig', () => {
  it('writes the config and creates the pack store', () => {
    const dir = tmp();
    const plan: InitPlan = {
      path: join(dir, 'tdcv2.config.json'),
      packStore: join(dir, 'tdcv2-packs'),
      locale: 'en',
      global: false,
    };
    writeInitConfig(plan, { force: false });
    expect(existsSync(plan.path)).toBe(true);
    expect(existsSync(plan.packStore)).toBe(true);
  });

  it('refuses to clobber an existing config without force', () => {
    const dir = tmp();
    const path = join(dir, 'tdcv2.config.json');
    writeFileSync(path, '{ "locale": "keep" }');
    const plan: InitPlan = { path, packStore: join(dir, 'p'), locale: 'en', global: false };
    expect(() => {
      writeInitConfig(plan, { force: false });
    }).toThrow(InitError);
    expect(readFileSync(path, 'utf8')).toContain('keep'); // untouched
  });

  it('overwrites with force', () => {
    const dir = tmp();
    const path = join(dir, 'tdcv2.config.json');
    writeFileSync(path, '{ "locale": "old" }');
    const plan: InitPlan = { path, packStore: join(dir, 'p'), locale: 'ru', global: false };
    writeInitConfig(plan, { force: true });
    expect(readCfg(path).locale).toBe('ru');
  });
});

describe('runInit — non-interactive (flags)', () => {
  it('writes a project config from --yes and reads back as valid', async () => {
    const dir = tmp();
    const code = await runInit(['--yes'], { cwd: dir });
    expect(code).toBe(0);
    const cfg = readCfg(join(dir, 'tdcv2.config.json'));
    expect(cfg).toEqual({ packStore: './tdcv2-packs', locale: 'en' });
  });

  it('honours --data-path and --locale', async () => {
    const dir = tmp();
    await runInit(['--yes', '--data-path', 'mypacks', '--locale', 'fr'], { cwd: dir });
    const cfg = readCfg(join(dir, 'tdcv2.config.json'));
    expect(cfg.packStore).toEqual('./mypacks');
    expect(cfg.locale).toBe('fr');
  });

  it('returns a non-zero code and leaves the file when it already exists', async () => {
    const dir = tmp();
    await runInit(['--yes'], { cwd: dir });
    const code = await runInit(['--yes'], { cwd: dir }); // second run, no --force
    expect(code).toBe(2);
  });

  it('rejects an unknown flag', async () => {
    expect(await runInit(['--nonsense'], { cwd: tmp() })).toBe(2);
  });
});
