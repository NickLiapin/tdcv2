/**
 * The editor reads the packs a person actually installed.
 *
 * This is the gap these tests exist for: `tdcv2 pack add sd` unpacks into a
 * store and registers it in `dataPaths`, and for a long time the language
 * server never read a config file at all. It scanned the bundled packs and two
 * conventional workspace folders, so an installed locale rendered perfectly
 * from the CLI and offered not one address in autocomplete. A missing
 * suggestion looks exactly like a suggestion that does not apply, which is why
 * nobody reported it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { packRootsFor, rootsChanged, stampRoots } from '../../src/lsp/pack-roots.js';

const made: string[] = [];

function workspace(config?: Record<string, unknown>): { dir: string; store: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tdc-lsp-roots-'));
  made.push(dir);
  const store = join(dir, 'installed-packs');
  mkdirSync(join(store, 'zz', 'person'), { recursive: true });
  writeFileSync(
    join(store, 'zz', 'person', 'lastName.txt'),
    '---\ndescription: x\nlocale: zz\n---\nAa\n',
  );
  if (config !== undefined) {
    writeFileSync(join(dir, 'tdcv2.config.json'), JSON.stringify(config), 'utf8');
  }
  return { dir, store };
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe('pack roots the language server scans', () => {
  it('includes a store the project config registers — the installed-pack case', () => {
    const { dir, store } = workspace({ dataPaths: ['./installed-packs'] });
    expect(packRootsFor([dir])).toContain(store);
  });

  it('finds nothing extra when no config names a store', () => {
    const { dir, store } = workspace();
    expect(packRootsFor([dir])).not.toContain(store);
  });

  it('still finds the conventional workspace folders', () => {
    const { dir } = workspace();
    const conventional = join(dir, 'data', 'packs');
    mkdirSync(conventional, { recursive: true });
    expect(packRootsFor([dir])).toContain(conventional);
  });

  it('a malformed config costs the editor nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-lsp-bad-'));
    made.push(dir);
    writeFileSync(join(dir, 'tdcv2.config.json'), '{ not json', 'utf8');
    const conventional = join(dir, 'packs');
    mkdirSync(conventional, { recursive: true });
    // The run will report the broken file; the editor keeps what it can see.
    expect(() => packRootsFor([dir])).not.toThrow();
    expect(packRootsFor([dir])).toContain(conventional);
  });

  it('names a root once even when two sources point at it', () => {
    const { dir, store } = workspace({ dataPaths: ['./installed-packs', './installed-packs'] });
    const roots = packRootsFor([dir]);
    expect(roots.filter((r) => r === store)).toHaveLength(1);
  });
});

describe('freshness check', () => {
  it('notices a root whose timestamp moved — a pack installed mid-session', () => {
    const { dir, store } = workspace({ dataPaths: ['./installed-packs'] });
    const roots = packRootsFor([dir]);
    const before = stampRoots(roots);
    // A pack landing in the store bumps the directory's mtime.
    const later = new Date(Date.now() + 10_000);
    utimesSync(store, later, later);
    expect(rootsChanged(before, stampRoots(roots))).toBe(true);
  });

  it('says nothing changed when nothing changed, so no rescan is paid for', () => {
    const { dir } = workspace({ dataPaths: ['./installed-packs'] });
    const roots = packRootsFor([dir]);
    const stamps = stampRoots(roots);
    expect(rootsChanged(stamps, stampRoots(roots))).toBe(false);
  });

  it('notices a root appearing, not only a root changing', () => {
    const { dir } = workspace();
    const before = stampRoots(packRootsFor([dir]));
    mkdirSync(join(dir, 'packs'), { recursive: true });
    expect(rootsChanged(before, stampRoots(packRootsFor([dir])))).toBe(true);
  });
});
