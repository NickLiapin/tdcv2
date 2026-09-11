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

import {
  packRootsFor,
  packViewOf,
  rootsChanged,
  stampRoots,
  uriToPath,
  workspaceRootsFrom,
} from '../../src/lsp/pack-roots.js';

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

/*
 * What a workspace folder's URI means, and what a registry looks like to the editor.
 *
 * Both used to sit in `server-impl.ts`, on the far side of the line this file's own header
 * draws — and the coverage exclusion that was supposed to cover that file named its 34-line
 * loader instead, so the adapter was measured after all and read 0%. Reading a URI and shaping
 * a registry are decisions, not wiring: they belong here, where a test can reach them without
 * an LSP client and without the optional `vscode-languageserver` packages.
 */
describe('a workspace folder as a directory', () => {
  it('reads a file: URI, and one with spaces in it', () => {
    expect(uriToPath('file:///tmp/work')).toBe('/tmp/work');
    expect(uriToPath('file:///tmp/my%20work')).toBe('/tmp/my work');
  });

  it('drops a folder there is no directory behind', () => {
    // A remote or virtual workspace arrives as some other scheme, and there is nothing to
    // scan. Dropped rather than guessed at — the editor keeps the roots it could resolve.
    expect(uriToPath('vscode-vfs://github/nick/tdc')).toBeUndefined();
    expect(uriToPath('untitled:Untitled-1')).toBeUndefined();
    expect(uriToPath('https://example.com/x')).toBeUndefined();
  });

  it('drops a file: URI there is no local directory behind', () => {
    // A UNC-style host is a real share, not a path this process can stat, and Node refuses to
    // convert it. A bad percent-escape is refused too. Either way the server keeps starting.
    expect(uriToPath('file://remote-host/share/packs')).toBeUndefined();
    expect(uriToPath('file:///a%ZZb')).toBeUndefined();
  });

  it('keeps the folders it can resolve and ignores the rest', () => {
    const { dir, store } = workspace({ dataPaths: ['./installed-packs'] });
    const roots = workspaceRootsFrom([
      { uri: 'vscode-vfs://github/nick/tdc' },
      { uri: `file://${dir}` },
    ]);
    expect(roots).toContain(store);
  });

  it('no folders at all is not an error — the bundled packs are still there', () => {
    expect(workspaceRootsFrom(undefined)).toEqual(workspaceRootsFrom([]));
  });
});

describe('a registry as the editor answers from it', () => {
  const registry = new Map([
    ['a.b', { address: 'a.b', description: 'first' }],
    ['c.d', { address: 'c.d' }],
  ]);

  it('gives diagnostics the addresses and completion the descriptions', () => {
    const view = packViewOf(registry as never);
    expect(view.addresses).toEqual(['a.b', 'c.d']);
    expect(view.infos).toEqual([{ address: 'a.b', description: 'first' }, { address: 'c.d' }]);
  });

  it('omits a description rather than carrying an empty one', () => {
    // The list shows `address — description`; an empty one leaves a dangling separator on
    // every row of a pack that has none.
    const view = packViewOf(registry as never);
    expect(Object.hasOwn(view.infos[1] ?? {}, 'description')).toBe(false);
  });

  it('an empty registry is an empty answer, not a crash', () => {
    const view = packViewOf(new Map() as never);
    expect(view.addresses).toEqual([]);
    expect(view.infos).toEqual([]);
  });
});
