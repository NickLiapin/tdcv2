/**
 * Which pack roots the editor reads — the same ones a run would.
 *
 * This lives apart from `server-impl.ts` on purpose. That file is a thin
 * protocol adapter, excluded from coverage because only a real editor
 * exercises it; deciding where the packs are is a real decision and has to be
 * testable without an LSP client.
 *
 * The first version of this logic scanned the bundled packs and two
 * conventional folders inside the workspace, and stopped. That left out the
 * packs people actually install: `tdcv2 pack add sd` unpacks into the store
 * named by `~/.config/tdcv2/config.json` or the project's `tdcv2.config.json`
 * and registers that store under `dataPaths`. So somebody could install Sindhi,
 * watch the CLI render it, and get completion for not one `sd.` address —
 * autocomplete disagreeing with the engine about what exists, which is the one
 * thing autocomplete must never do.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/config.js';
import { bundledPacksDir, type PackRegistry } from '../data-pack/index.js';
import type { PackAddressInfo } from './completion.js';

/**
 * Roots for a set of workspace directories, lowest priority first.
 *
 * `loadConfig` is the same call the CLI, `pack`, `init` and the Quick API make,
 * so the editor resolves roots exactly as a run does. A config that will not
 * parse is the run's problem to report — losing every pack the editor can still
 * see would be a worse answer than ignoring one broken file, so it is caught.
 */
export function packRootsFor(workspaceDirs: readonly string[]): readonly string[] {
  const roots: string[] = [];
  const bundled = bundledPacksDir();
  if (bundled !== undefined) roots.push(bundled);
  for (const dir of workspaceDirs) {
    try {
      for (const p of loadConfig({ cwd: dir }).dataPaths) {
        if (existsSync(p)) roots.push(p);
      }
    } catch {
      // Keep going: a malformed config must not cost the editor the rest.
    }
    for (const candidate of [join(dir, 'data', 'packs'), join(dir, 'packs')]) {
      if (existsSync(candidate)) roots.push(candidate);
    }
  }
  return [...new Set(roots)];
}

/**
 * One stat per root — the cheap half of the freshness check.
 *
 * Installing a pack changes the store directory's mtime, and registering it
 * changes the set of roots. Walking a hundred locale packs takes seconds and
 * cannot happen per keystroke; comparing stamps takes microseconds, so the walk
 * only runs when something actually moved.
 */
export function stampRoots(roots: readonly string[]): ReadonlyMap<string, number> {
  const stamps = new Map<string, number>();
  for (const root of roots) {
    try {
      stamps.set(root, statSync(root).mtimeMs);
    } catch {
      stamps.set(root, 0);
    }
  }
  return stamps;
}

/** True when the roots or their timestamps have moved since `previous`. */
export function rootsChanged(
  previous: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>,
): boolean {
  if (previous.size !== current.size) return true;
  for (const [root, stamp] of current) {
    if (previous.get(root) !== stamp) return true;
  }
  return false;
}

/**
 * A workspace folder's URI as a plain directory, or nothing.
 *
 * The protocol hands folders over as URIs and says nothing about the scheme. A remote or virtual
 * workspace arrives as something other than `file:`, and there is no directory behind it to scan —
 * so it is dropped rather than guessed at. A malformed `file:` URI is dropped the same way: the
 * editor keeps working with the roots it could resolve, which is a better answer than a language
 * server that will not start.
 */
export function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * The pack roots for a set of workspace folders, straight from what `initialize` sent.
 *
 * Takes the folders rather than the whole `InitializeParams` so this module never imports the
 * LSP packages — they are OPTIONAL peer dependencies, absent from a plain `npm install tdcv2`,
 * and a module that is measured and tested must not need them.
 */
export function workspaceRootsFrom(
  folders: readonly { readonly uri: string }[] | undefined,
): readonly string[] {
  const dirs: string[] = [];
  for (const folder of folders ?? []) {
    const dir = uriToPath(folder.uri);
    if (dir !== undefined) dirs.push(dir);
  }
  return packRootsFor(dirs);
}

/**
 * A scanned registry as the two shapes the editor answers from.
 *
 * Addresses feed diagnostics — so a known pack template is not flagged as unknown — and the
 * richer infos feed completion, where the description is what tells one address from another in
 * the list. A pack without a description contributes none rather than an empty one, or the list
 * shows a dangling separator against half its rows.
 */
export function packViewOf(registry: PackRegistry): {
  readonly addresses: readonly string[];
  readonly infos: readonly PackAddressInfo[];
} {
  return {
    addresses: [...registry.keys()],
    infos: [...registry.values()].map((entry) => ({
      address: entry.address,
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    })),
  };
}
