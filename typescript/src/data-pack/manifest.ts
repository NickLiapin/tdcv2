/**
 * `_pack.json` — who wrote a folder of packs, under what licence, at what version.
 *
 * The pack format is otherwise all content and no provenance: a folder of `.txt`
 * lists and `.tdc` generators says what it produces and nothing about where it
 * came from. That is fine while the only packs are the bundled ones, and stops
 * being fine the moment somebody downloads a folder from a colleague, a registry
 * or a company share and has to answer "may we ship data built from this?".
 *
 * Everything here is OPTIONAL and nothing here reaches the generated data. A
 * manifest cannot change a single value: it describes the folder it sits in, and
 * `tdcv2 pack info` is what reads it back.
 *
 * ── Why a broken one is an error ─────────────────────────────────────────────
 * The tolerant reading — ignore what will not parse, carry on — is right for
 * `_locale.json`, where the fallback (the folder's own name, the script's usual
 * direction) is what the file would have said anyway. It is wrong here: the
 * fallback for a broken manifest is NO LICENCE AT ALL, and a licence nobody can
 * see is worse than one nobody wrote. So it takes `DATE_LOCALE.json`'s road
 * instead and says so out loud, under the same TDC170 every unusable pack file
 * uses.
 */

/** The fields a `_pack.json` may carry. Every one of them is optional. */
export interface PackManifest {
  /** A human name for the folder — "Acme internal packs". */
  readonly name?: string | undefined;
  /** The folder's own version, in whatever scheme its author keeps. */
  readonly version?: string | undefined;
  /** An SPDX identifier where there is one — "MIT", "CC-BY-4.0", "Proprietary". */
  readonly license?: string | undefined;
  readonly author?: string | undefined;
  readonly homepage?: string | undefined;
  readonly description?: string | undefined;
}

export const PACK_MANIFEST_FILENAME = '_pack.json';

/** The fields read back, in the order `pack info` prints them. */
export const PACK_MANIFEST_FIELDS = [
  'name',
  'version',
  'license',
  'author',
  'homepage',
  'description',
] as const;

/**
 * Parse a `_pack.json`, or return the complaint to raise.
 *
 * Unknown keys are kept quietly: a manifest is metadata, and a folder written
 * for a newer TDC — or for a company's own tooling beside it — must not stop
 * working here because it carries a field this version has no use for. What is
 * refused is a field that IS known and holds the wrong kind of thing, because
 * that one was meant for this reader and will not arrive.
 */
export function parsePackManifest(content: string, folder: string): PackManifest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    return (
      `${PACK_MANIFEST_FILENAME} in "${folder}" is not valid JSON ` +
      `(${(error as Error).message}); nothing in this folder is described until it is fixed`
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${PACK_MANIFEST_FILENAME} in "${folder}" must be a JSON object, e.g. {"license": "MIT"}`;
  }

  const table = raw as Record<string, unknown>;
  const manifest: Record<string, string> = {};
  for (const field of PACK_MANIFEST_FIELDS) {
    const value = table[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return (
        `${PACK_MANIFEST_FILENAME} in "${folder}" has "${field}" as ` +
        `${Array.isArray(value) ? 'a list' : typeof value}, and it must be text`
      );
    }
    if (value.trim() !== '') manifest[field] = value;
  }
  return manifest;
}

/** One folder's manifest, and where it was found. */
export interface FoundManifest {
  readonly folder: string;
  readonly manifest: PackManifest;
}

/** What a sweep of the configured folders turned up. */
export interface ManifestSweep {
  readonly found: readonly FoundManifest[];
  /** One line per manifest that would not parse, in the order the folders were read. */
  readonly broken: readonly string[];
}

/**
 * Look for `_pack.json` in each root and in each of its top-level folders.
 *
 * Two depths rather than a full walk, and deliberately: a manifest describes a
 * FOLDER OF PACKS, which is either a data path somebody configured or one locale
 * inside it. Walking deeper would invite a manifest per `.txt` file, and the
 * question this answers — who wrote this data, and under what licence — is not
 * one a single list of city names has its own answer to.
 *
 * `read` returns the file's text, or `undefined` when there is none; `folders`
 * lists a directory's subdirectories. Both are passed in so this stays a pure
 * function of what it is told, and so the four ports can hand it their own.
 */
export function sweepPackManifests(
  roots: readonly string[],
  read: (path: string) => string | undefined,
  folders: (path: string) => readonly string[],
  join: (a: string, b: string) => string,
): ManifestSweep {
  const found: FoundManifest[] = [];
  const broken: string[] = [];
  const seen = new Set<string>();

  const visit = (folder: string): void => {
    if (seen.has(folder)) return; // a root listed twice describes itself once
    seen.add(folder);
    const content = read(join(folder, PACK_MANIFEST_FILENAME));
    if (content === undefined) return;
    const parsed = parsePackManifest(content, folder);
    if (typeof parsed === 'string') broken.push(parsed);
    else found.push({ folder, manifest: parsed });
  };

  for (const root of roots) {
    visit(root);
    for (const name of folders(root)) visit(join(root, name));
  }
  return { found, broken };
}

/**
 * How a found folder is printed: relative to where the command was run when it
 * sits inside, absolute otherwise.
 *
 * A project's own packs live under the project, so the reader sees `mypacks/en`
 * rather than sixty characters of temp path — and a store somewhere else in the
 * filesystem still says where it really is.
 */
export function displayFolder(
  folder: string,
  cwd: string,
  relative: (a: string, b: string) => string,
): string {
  const rel = relative(cwd, folder);
  if (rel === '') return '.';
  return rel.startsWith('..') ? folder : rel;
}
