/**
 * Pure logic for `tdcv2 pack`: parsing the registry index, verifying a download
 * by hash, seeing what is already installed, and registering a bundle's pack
 * root in the config file.
 *
 * The network and the unzip live in `pack.ts`; keeping the decisions here — what
 * the index means, whether a download is intact, which folder to register —
 * makes them testable without touching the wire.
 *
 * Bundles are axis-pure — one language (`en`), or one country (`usa`), or
 * `common` — because language and country are independent dimensions that
 * compose (US English = common + en + usa). A downloaded bundle extracts to
 * `<store>/<id>/`, mirroring the zip's own top folder (`en/packs/…`). Only the
 * `packs` folder is a scan root — registered in `dataPaths` so addresses resolve
 * as `en.person.lastName`, not `en.packs.en.person.…`. The store itself is never
 * scanned.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** The folder inside a bundle that is a pack scan root. */
export const BUNDLE_PACKS_DIR = 'packs';

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

/** Where a bundle lives once extracted: `<store>/<id>`. */
export function bundleDir(store: string, id: string): string {
  return join(store, id);
}

/** The scan root registered for a bundle: `<store>/<id>/packs`. */
export function bundlePacksRoot(store: string, id: string): string {
  return join(store, id, BUNDLE_PACKS_DIR);
}

/**
 * Bundle ids already installed in the store — a subfolder that carries a
 * `packs/` directory. Missing store → nothing installed (not an error).
 */
export function installedBundleIds(store: string): string[] {
  if (!existsSync(store)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(store, entry.name, BUNDLE_PACKS_DIR))) {
      ids.push(entry.name);
    }
  }
  return ids.sort();
}

/** True if `child` is the same as, or nested under, `parent`. Guards zip-slip. */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Register a bundle's pack root in a config file's `dataPaths`. Reads the JSON,
 * appends the path (written relative when it sits under the config's folder, the
 * way `init` writes paths), de-duplicates, and writes it back preserving the
 * other settings. Returns whether anything changed.
 */
export function registerBundleInConfig(
  configPath: string,
  packsRoot: string,
): { added: boolean; stored: string } {
  const text = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PackError(`config "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackError(`config "${configPath}" must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;
  const configDir = dirname(resolve(configPath));

  const stored = storablePath(configDir, packsRoot);

  const existing: string[] = Array.isArray(cfg['dataPaths'])
    ? cfg['dataPaths'].filter((p): p is string => typeof p === 'string')
    : [];

  // De-dupe by resolved absolute path, so `./x` and an absolute `/…/x` do not
  // both land in the file.
  const already = existing.some((p) => resolvedFrom(configDir, p) === resolve(packsRoot));
  if (already) return { added: false, stored };

  cfg['dataPaths'] = [...existing, stored];
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { added: true, stored };
}

/**
 * The inverse of {@link registerBundleInConfig}: drop the bundle's pack root from
 * the config's `dataPaths` (matched by resolved path, so a relative or absolute
 * entry both go). Returns whether anything was removed. The bundled default for
 * those addresses, being a lower-priority root, simply resurfaces.
 */
export function unregisterBundleFromConfig(
  configPath: string,
  packsRoot: string,
): { removed: boolean } {
  const text = readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PackError(`config "${configPath}" is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PackError(`config "${configPath}" must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;
  const configDir = dirname(resolve(configPath));
  const existing: string[] = Array.isArray(cfg['dataPaths'])
    ? cfg['dataPaths'].filter((p): p is string => typeof p === 'string')
    : [];
  const target = resolve(packsRoot);
  const kept = existing.filter((p) => resolvedFrom(configDir, p) !== target);
  if (kept.length === existing.length) return { removed: false };
  cfg['dataPaths'] = kept;
  writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return { removed: true };
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
