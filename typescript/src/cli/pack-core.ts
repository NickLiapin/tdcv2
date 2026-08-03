/**
 * Pure logic for `tdcv2 pack`: parsing the registry index, verifying a download
 * by hash, keeping the store's books, and registering the store in the config.
 *
 * The network and the unzip live in `pack.ts`; keeping the decisions here — what
 * the index means, whether a download is intact, which paths a bundle owns —
 * makes them testable without touching the wire.
 *
 * Bundles are axis-pure — one language (`en`), or one country (`usa`), or
 * `common` — because language and country are independent dimensions that
 * compose (US English = common + en + usa). They all unpack into ONE tree:
 *
 *   <store>/.tdcv2-installed.json
 *   <store>/common/…
 *   <store>/en/…
 *   <store>/countries/usa/…
 *
 * The address path is the only level that has to exist, so it is the only level
 * there is. The store is a single scan root, registered in `dataPaths` once, and
 * a bundle is no longer identifiable by a folder named after it — which is what
 * the bookkeeping file is for: it records the paths each bundle owns, so
 * `pack remove` deletes exactly those and `pack list` knows what is installed.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The folder inside a bundle's zip that holds its pack tree. */
export const BUNDLE_PACKS_DIR = 'packs';

/**
 * The store's bookkeeping file.
 *
 * A DOTFILE because it sits at the root of a scan root, and the pack loader
 * skips ignored NAMES rather than unknown extensions — a plain `installed.json`
 * here would be read as a pack at address `installed`.
 */
export const INSTALLED_FILE = '.tdcv2-installed.json';

/** Bumped only if the record's shape changes in a way older tools misread. */
export const INSTALLED_SCHEMA_VERSION = 1;

export class PackError extends Error {
  public override readonly name = 'PackError';
}

/** One downloadable bundle, as described by the registry `index.json`. */
export interface PackBundle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Path of the zip relative to the registry base URL, e.g. `bundles/en.zip`. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /**
   * What the registry calls this revision of the bundle. Optional: today's
   * index declares none, and the digest already tells two revisions apart —
   * but the store writes down whatever the registry did say, so a registry
   * that starts versioning its bundles is understood without a client change.
   */
  readonly version: string | undefined;
  readonly locale: string | undefined;
  readonly country: string | undefined;
  /** Human-readable list of what the bundle provides (informational). */
  readonly contents: readonly string[];
  /**
   * Continents a country belongs to, and roughly where it sits as [longitude, latitude].
   *
   * Both come from the registry so the interactive picker can group and plot a country without
   * keeping a copy of world geography — the picker exists in three languages, and three copies
   * would be three copies that drift. Absent for languages and for `common`, and absent from an
   * older index, which is why nothing here is required.
   */
  readonly regions: readonly string[] | undefined;
  readonly point: readonly [number, number] | undefined;
}

/** The registry catalogue. */
export interface PackIndex {
  readonly schemaVersion: number;
  readonly description: string | undefined;
  readonly bundles: readonly PackBundle[];
}

/** Shape of the raw JSON before validation. */
interface RawIndex {
  readonly schemaVersion?: unknown;
  readonly description?: unknown;
  readonly bundles?: unknown;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PackError(`registry index: ${what} must be a non-empty string`);
  }
  return value;
}

function asOptionalString(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, what);
}

function parseBundle(raw: unknown, i: number): PackBundle {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PackError(`registry index: bundles[${String(i)}] must be an object`);
  }
  const b = raw as Record<string, unknown>;
  const bytes = b['bytes'];
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
    throw new PackError(
      `registry index: bundles[${String(i)}].bytes must be a non-negative number`,
    );
  }
  let contents: readonly string[] = [];
  if (b['contents'] !== undefined) {
    if (!Array.isArray(b['contents'])) {
      throw new PackError(`registry index: bundles[${String(i)}].contents must be an array`);
    }
    contents = b['contents'].map((c, j) =>
      asString(c, `bundles[${String(i)}].contents[${String(j)}]`),
    );
  }
  return {
    id: asString(b['id'], `bundles[${String(i)}].id`),
    name: asString(b['name'], `bundles[${String(i)}].name`),
    description: asOptionalString(b['description'], `bundles[${String(i)}].description`) ?? '',
    file: asString(b['file'], `bundles[${String(i)}].file`),
    bytes,
    sha256: asString(b['sha256'], `bundles[${String(i)}].sha256`).toLowerCase(),
    version: asOptionalString(b['version'], `bundles[${String(i)}].version`),
    locale: asOptionalString(b['locale'], `bundles[${String(i)}].locale`),
    country: asOptionalString(b['country'], `bundles[${String(i)}].country`),
    regions: asRegions(b['regions'], i),
    point: asPoint(b['point'], i),
    contents,
  };
}

function asRegions(value: unknown, i: number): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PackError(`registry index: bundles[${String(i)}].regions must be an array`);
  }
  return value.map((r, j) => asString(r, `bundles[${String(i)}].regions[${String(j)}]`));
}

function asPoint(value: unknown, i: number): readonly [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2 || value.some((n) => typeof n !== 'number')) {
    throw new PackError(
      `registry index: bundles[${String(i)}].point must be [longitude, latitude]`,
    );
  }
  return [value[0] as number, value[1] as number];
}

/** Parse and validate a registry `index.json`. Malformed input is a clear error. */
export function parseIndex(text: string): PackIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PackError(`registry index is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackError('registry index must be a JSON object');
  }
  const raw = parsed as RawIndex;
  if (typeof raw.schemaVersion !== 'number') {
    throw new PackError('registry index: "schemaVersion" must be a number');
  }
  if (raw.schemaVersion !== 1) {
    throw new PackError(
      `registry index: unsupported schemaVersion ${String(raw.schemaVersion)} — update tdcv2`,
    );
  }
  if (!Array.isArray(raw.bundles)) {
    throw new PackError('registry index: "bundles" must be an array');
  }
  const bundles = raw.bundles.map((b, i) => parseBundle(b, i));
  return {
    schemaVersion: raw.schemaVersion,
    description: asOptionalString(raw.description, 'description'),
    bundles,
  };
}

/** Find a bundle by id, or throw a helpful error listing what is available. */
export function findBundle(index: PackIndex, id: string): PackBundle {
  const bundle = index.bundles.find((b) => b.id === id);
  if (!bundle) {
    const known = index.bundles.map((b) => b.id).join(', ') || '(none)';
    throw new PackError(`unknown bundle "${id}". Available: ${known}`);
  }
  return bundle;
}

/** Verify downloaded bytes against the expected sha256 (case-insensitive hex). */
export function verifySha256(data: Uint8Array, expected: string): boolean {
  const actual = createHash('sha256').update(data).digest('hex');
  return actual.toLowerCase() === expected.trim().toLowerCase();
}

/** One bundle as the store has it. */
export interface InstalledBundle {
  readonly id: string;
  /**
   * The paths this bundle owns, relative to the store and always `/`-separated.
   * `pack remove` deletes exactly these; a bundle in a shared tree cannot be
   * found by looking for a folder with its name.
   */
  readonly paths: readonly string[];
  /** What the registry called this revision, or `""` when it called it nothing. */
  readonly version: string;
  /** Digest of the archive it came from; `""` for an install migrated from the old layout. */
  readonly sha256: string;
  /** How many files it wrote. */
  readonly files: number;
}

/** The bookkeeping file's contents. */
export interface InstalledRecord {
  readonly schemaVersion: number;
  /** Sorted by id, so the file is stable to diff. */
  readonly bundles: readonly InstalledBundle[];
}

/** Where the bookkeeping file lives. */
export function installedFilePath(store: string): string {
  return join(store, INSTALLED_FILE);
}

const EMPTY_RECORD: InstalledRecord = { schemaVersion: INSTALLED_SCHEMA_VERSION, bundles: [] };

/**
 * Read the store's books. A missing file means an empty store; a malformed one
 * is an ERROR rather than an empty store, because "nothing is installed" would
 * make `pack remove` claim there is nothing to delete while the files sit there.
 */
export function readInstalled(store: string): InstalledRecord {
  const path = installedFilePath(store);
  if (!existsSync(path)) return EMPTY_RECORD;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new PackError(
      `pack store record "${path}" is not valid JSON: ${(err as Error).message}. ` +
        `Delete it and re-add your bundles.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackError(`pack store record "${path}" must be a JSON object`);
  }
  const raw = parsed as { bundles?: unknown; schemaVersion?: unknown };
  if (typeof raw.schemaVersion !== 'number') {
    throw new PackError(`pack store record "${path}": "schemaVersion" must be a number`);
  }
  if (raw.schemaVersion > INSTALLED_SCHEMA_VERSION) {
    throw new PackError(
      `pack store record "${path}" was written by a newer tdcv2 ` +
        `(schemaVersion ${String(raw.schemaVersion)}) — update tdcv2`,
    );
  }
  if (!Array.isArray(raw.bundles)) {
    throw new PackError(`pack store record "${path}": "bundles" must be an array`);
  }
  const bundles = raw.bundles.map((b, i) => parseInstalledBundle(b, i, path, store));
  return { schemaVersion: raw.schemaVersion, bundles: sortById(bundles) };
}

function parseInstalledBundle(
  raw: unknown,
  i: number,
  path: string,
  store: string,
): InstalledBundle {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PackError(`pack store record "${path}": bundles[${String(i)}] must be an object`);
  }
  const b = raw as Record<string, unknown>;
  const id = asString(b['id'], `bundles[${String(i)}].id`);
  if (!Array.isArray(b['paths'])) {
    throw new PackError(
      `pack store record "${path}": bundles[${String(i)}].paths must be an array`,
    );
  }
  const paths = b['paths'].map((p, j) => {
    const value = asString(p, `bundles[${String(i)}].paths[${String(j)}]`);
    // Everything in here is deleted verbatim by `pack remove`, so a hand-edited
    // or hostile record must not be able to point outside the store.
    if (isAbsolute(value) || !isPathInside(join(store, value), store)) {
      throw new PackError(
        `pack store record "${path}": bundle "${id}" claims a path outside the store: "${value}"`,
      );
    }
    return value;
  });
  return {
    id,
    paths,
    version: typeof b['version'] === 'string' ? b['version'] : '',
    sha256: typeof b['sha256'] === 'string' ? b['sha256'] : '',
    files: typeof b['files'] === 'number' ? b['files'] : 0,
  };
}

function sortById(bundles: readonly InstalledBundle[]): InstalledBundle[] {
  return [...bundles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Write the store's books, ids sorted so re-installing the same set is a no-diff. */
export function writeInstalled(store: string, record: InstalledRecord): void {
  mkdirSync(store, { recursive: true });
  const body = { schemaVersion: INSTALLED_SCHEMA_VERSION, bundles: sortById(record.bundles) };
  writeFileSync(installedFilePath(store), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** The record with `entry` put in place of any earlier install of the same id. */
export function withBundle(record: InstalledRecord, entry: InstalledBundle): InstalledRecord {
  return {
    schemaVersion: INSTALLED_SCHEMA_VERSION,
    bundles: sortById([...record.bundles.filter((b) => b.id !== entry.id), entry]),
  };
}

/** The record without `id`. */
export function withoutBundle(record: InstalledRecord, id: string): InstalledRecord {
  return {
    schemaVersion: INSTALLED_SCHEMA_VERSION,
    bundles: record.bundles.filter((b) => b.id !== id),
  };
}

/**
 * Bundle ids the store has, from its books. Missing store → nothing installed
 * (not an error). A tree somebody unpacked by hand is not "installed": nothing
 * records what it owns, so nothing could remove it cleanly either.
 */
export function installedBundleIds(store: string): string[] {
  return readInstalled(store)
    .bundles.map((b) => b.id)
    .sort();
}

/**
 * The paths a bundle owns, given every file it carries (store-relative,
 * `/`-separated).
 *
 * Usually one path: every file of `ru` sits under `ru/`, every file of `russia`
 * under `countries/russia/`, so the longest shared directory IS the subtree the
 * bundle owns — and `countries/`, which several bundles share, is correctly not
 * claimed by any of them. A bundle whose files diverge at the top level owns
 * each of those top-level entries instead, which keeps the answer an antichain:
 * no owned path contains another.
 */
export function bundleOwnedPaths(files: readonly string[]): string[] {
  if (files.length === 0) return [];
  const dirs = files.map((f) => f.split('/').slice(0, -1));
  let common = dirs[0] ?? [];
  for (const d of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  if (common.length > 0) return [common.join('/')];
  return [...new Set(files.map((f) => f.split('/')[0] ?? ''))].filter((s) => s !== '').sort();
}

/** True if `child` is the same as, or nested under, `parent`. Guards zip-slip. */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Read a config file as a JSON object, complaining precisely if it is not one. */
function readConfigObject(configPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new PackError(`config "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackError(`config "${configPath}" must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function currentDataPaths(cfg: Record<string, unknown>): string[] {
  return Array.isArray(cfg['dataPaths'])
    ? cfg['dataPaths'].filter((p): p is string => typeof p === 'string')
    : [];
}

/**
 * Add a scan root to a config file's `dataPaths`. Written relative when it sits
 * under the config's folder (the way `init` writes paths), de-duplicated by
 * resolved path, and written back preserving every other setting — including the
 * ones this tool knows nothing about. Returns whether anything changed.
 *
 * `pack add` calls this with the STORE, once, however many bundles land in it.
 */
export function addDataPath(configPath: string, path: string): { added: boolean; stored: string } {
  const cfg = readConfigObject(configPath);
  const configDir = dirname(resolve(configPath));
  const stored = storablePath(configDir, path);
  const existing = currentDataPaths(cfg);

  // De-dupe by resolved absolute path, so `./x` and an absolute `/…/x` do not
  // both land in the file.
  if (existing.some((p) => resolvedFrom(configDir, p) === resolve(path))) {
    return { added: false, stored };
  }
  cfg['dataPaths'] = [...existing, stored];
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { added: true, stored };
}

/**
 * The inverse of {@link addDataPath}: drop a scan root from `dataPaths` (matched
 * by resolved path, so a relative or absolute entry both go). Returns whether
 * anything was removed. The bundled default for those addresses, being a
 * lower-priority root, simply resurfaces.
 */
export function removeDataPath(configPath: string, path: string): { removed: boolean } {
  const cfg = readConfigObject(configPath);
  const configDir = dirname(resolve(configPath));
  const existing = currentDataPaths(cfg);
  const target = resolve(path);
  const kept = existing.filter((p) => resolvedFrom(configDir, p) !== target);
  if (kept.length === existing.length) return { removed: false };
  cfg['dataPaths'] = kept;
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { removed: true };
}

/**
 * Drop every `dataPaths` entry that points INSIDE the store (the store itself is
 * kept). That is the per-bundle registration the old layout needed — a hundred
 * of them for a hundred bundles — and after the move each one names a folder that
 * no longer exists. Returns how many went.
 */
export function removeDataPathsInside(configPath: string, store: string): number {
  const cfg = readConfigObject(configPath);
  const configDir = dirname(resolve(configPath));
  const existing = currentDataPaths(cfg);
  const root = resolve(store);
  const kept = existing.filter((p) => {
    const abs = resolvedFrom(configDir, p);
    return abs === root || !isPathInside(abs, root);
  });
  if (kept.length === existing.length) return 0;
  cfg['dataPaths'] = kept;
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return existing.length - kept.length;
}

/** Resolve a possibly-relative config path against the config's directory. */
function resolvedFrom(configDir: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(configDir, p);
}

/** A path relative to the config dir when under it (portable), else absolute. */
function storablePath(configDir: string, target: string): string {
  const abs = resolve(target);
  const base = resolve(configDir);
  if (abs === base) return '.';
  if (isPathInside(abs, base)) return `./${relative(base, abs).split('\\').join('/')}`;
  return abs;
}

// ── the store's own files ─────────────────────────────────────────────────────

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every file under `dir`, as `/`-separated paths relative to it, sorted.
 * Dotfiles included: `_locale.json` and anything else the packs carry has to
 * travel with them, and deciding what is "really" data is the loader's job.
 */
export function walkRelative(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkRelative(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Move one file, falling back to copy+delete if the store spans two devices. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * Delete every empty directory in `dir`'s subtree, and `dir` itself if that
 * leaves it empty. Returns whether `dir` is gone. Moving files out leaves the
 * whole shape of the old tree behind, and empty folders in a scan root are noise
 * a user then has to wonder about.
 */
function pruneEmptyTree(dir: string): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const entry of entries) {
    if (!entry.isDirectory() || !pruneEmptyTree(join(dir, entry.name))) empty = false;
  }
  if (!empty) return false;
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Delete `dir` and every empty parent up to (but never including) `stopAt`. */
export function pruneEmptyDirs(dir: string, stopAt: string): void {
  let current = resolve(dir);
  const root = resolve(stopAt);
  while (current !== root && isPathInside(current, root)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

// ── migrating a store written by an older tdcv2 ───────────────────────────────

/** One bundle's tree, moved out of its old folder. */
export interface StoreMove {
  readonly id: string;
  /** Store-relative source, e.g. `ru/packs/ru`. */
  readonly from: string;
  /** Store-relative destination, e.g. `ru`. */
  readonly to: readonly string[];
  readonly files: number;
}

/** What {@link migrateStore} did, for the caller to report. */
export interface StoreMigration {
  readonly store: string;
  readonly moves: readonly StoreMove[];
  /**
   * Files that were in a bundle's old folder but OUTSIDE its `packs/` tree.
   * They belong to no pack address, so they are left exactly where they are
   * rather than being guessed at or deleted.
   */
  readonly leftovers: readonly string[];
  readonly droppedDataPaths: number;
  /** The store, as written into `dataPaths`; undefined if it was already there. */
  readonly registered: string | undefined;
}

/** Bundle folders in the old layout: `<store>/<id>/packs/…`. */
export function legacyBundleIds(store: string): string[] {
  if (!isDirectory(store)) return [];
  return readdirSync(store, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isDirectory(join(store, e.name, BUNDLE_PACKS_DIR)))
    .map((e) => e.name)
    .sort();
}

/**
 * Move a store written by an older tdcv2 into the flat layout, in place.
 *
 * Returns undefined when there is nothing to move. Everything is PLANNED before
 * anything moves: a store half in one layout and half in the other is worse than
 * one that refused and said why, and the refusal costs the user only the two
 * minutes it takes to move the offending file themselves.
 *
 * Anyone who ran `pack add` before the flat store has `<store>/<id>/packs/…` on
 * disk and one `dataPaths` entry per bundle in their config; both are fixed here,
 * so the first `tdcv2 pack` after an upgrade is all it takes.
 */
export function migrateStore(store: string, configPath: string): StoreMigration | undefined {
  const ids = legacyBundleIds(store);
  if (ids.length === 0) return undefined;

  const packsRootOf = (id: string): string => join(store, id, BUNDLE_PACKS_DIR);
  const planned = new Map<string, { id: string; from: string }>();
  const perBundle: { id: string; rels: string[] }[] = [];
  const conflicts: string[] = [];
  const leftovers: string[] = [];

  for (const id of ids) {
    const rels = walkRelative(packsRootOf(id));
    perBundle.push({ id, rels });
    // Read before anything moves: a bundle whose tree lands back under its own
    // name (`ru/packs/ru` → `ru`) would otherwise report its own data as a
    // leftover the moment it arrived.
    for (const rel of walkRelative(join(store, id))) {
      if (!rel.startsWith(`${BUNDLE_PACKS_DIR}/`)) leftovers.push(`${id}/${rel}`);
    }
    for (const rel of rels) {
      const dest = join(store, rel);
      if (!isPathInside(dest, store)) {
        conflicts.push(`${id}: "${rel}" would land outside the store`);
        continue;
      }
      const claimed = planned.get(dest);
      if (claimed !== undefined) {
        conflicts.push(`${rel}: claimed by both "${claimed.id}" and "${id}"`);
        continue;
      }
      if (existsSync(dest)) {
        conflicts.push(`${rel}: something is already there`);
        continue;
      }
      // Landing inside another bundle's old folder would move a file out from
      // under a move still to come.
      if (ids.some((other) => other !== id && isPathInside(dest, packsRootOf(other)))) {
        conflicts.push(`${rel}: it would land inside another bundle's old folder`);
        continue;
      }
      planned.set(dest, { id, from: join(packsRootOf(id), rel) });
    }
  }

  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 5).map((c) => `  ${c}`);
    if (conflicts.length > 5) shown.push(`  … and ${String(conflicts.length - 5)} more`);
    throw new PackError(
      `cannot move the pack store "${store}" to the flat layout — ` +
        `${String(conflicts.length)} path(s) collide:\n${shown.join('\n')}\n` +
        `Nothing was moved. Clear those paths, or delete the store and run \`tdcv2 pack add\` again.`,
    );
  }

  for (const [dest, source] of planned) {
    mkdirSync(dirname(dest), { recursive: true });
    moveFile(source.from, dest);
  }

  let record = readInstalled(store);
  const moves: StoreMove[] = [];
  for (const { id, rels } of perBundle) {
    const paths = bundleOwnedPaths(rels);
    record = withBundle(record, { id, paths, version: '', sha256: '', files: rels.length });
    moves.push({
      id,
      from: `${id}/${BUNDLE_PACKS_DIR}`,
      to: paths,
      files: rels.length,
    });
    pruneEmptyTree(packsRootOf(id));
    pruneEmptyTree(join(store, id));
  }
  writeInstalled(store, record);

  const droppedDataPaths = removeDataPathsInside(configPath, store);
  const { added, stored } = addDataPath(configPath, store);
  return {
    store,
    moves,
    leftovers,
    droppedDataPaths,
    registered: added ? stored : undefined,
  };
}
