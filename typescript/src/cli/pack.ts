/**
 * `tdcv2 pack` — get data packs onto disk without the user hand-managing folders
 * or paths.
 *
 * In a real terminal it opens a small menu: browse the registry, tick the
 * bundles you want, and it downloads, verifies by hash, extracts into the pack
 * store, and wires the store into your config — so the data is usable by its
 * normal address the moment it lands. With no terminal it is scriptable:
 * `pack list` and `pack add <id…>`.
 *
 * Everything lands in ONE tree, at its address path: `<store>/ru/…`,
 * `<store>/countries/russia/…`. Which bundle owns which path is written down in
 * `<store>/.tdcv2-installed.json` rather than implied by a folder name, so ten
 * languages and a hundred countries are one folder and one `dataPaths` entry.
 *
 * The wire (fetch) and the unzip live here; the decisions (what the index means,
 * whether a download is intact, what a bundle owns) are pure in `pack-core.ts`.
 * Inquirer and fflate are imported lazily so the ordinary generate path never
 * pays for them.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/config.js';
import {
  BUNDLE_PACKS_DIR,
  PackError,
  addDataPath,
  bundleOwnedPaths,
  findBundle,
  installedBundleIds,
  isPathInside,
  migrateStore,
  parseIndex,
  pruneEmptyDirs,
  readInstalled,
  removeDataPath,
  verifySha256,
  withBundle,
  withoutBundle,
  writeInstalled,
  type InstalledRecord,
  type PackBundle,
  type PackIndex,
  type StoreMigration,
} from './pack-core.js';

/**
 * The same text the other four implementations print, to the byte. `pack` is
 * one command with five front ends, and a reader who checks the subcommands in
 * one of them must not find a different list in the next.
 */
const USAGE = `Usage: tdcv2 pack [command]

  list                  Show what can be installed, and what already is
  add <id>...           Download and install one or more bundles
  remove <id>...        Uninstall, and drop them from the config

  --registry <url>      Use another registry (default: the public one)
`;

/** The public data-pack registry. Overridable with `--registry <base-url>`. */
export const DEFAULT_REGISTRY =
  'https://raw.githubusercontent.com/NickLiapin/tdcv2-data-packs/master';

export interface PackContext {
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Where downloads go and which config file records them — from the cascade. */
interface Store {
  readonly path: string;
  readonly configPath: string;
}

/**
 * Resolve the pack store from the config cascade. Downloading needs somewhere to
 * put packs and a config to record them in, both of which `tdcv2 init` creates.
 */
function resolveStore(ctx: PackContext): Store {
  const cfg = loadConfig({
    cwd: ctx.cwd,
    home: ctx.home,
    platform: ctx.platform,
    env: ctx.env,
  });
  if (cfg.packStore === undefined || cfg.packStoreSource === undefined) {
    throw new PackError('no pack store configured — run `tdcv2 init` first');
  }
  return { path: cfg.packStore, configPath: cfg.packStoreSource };
}

// ── the wire ────────────────────────────────────────────────────────────────

/**
 * A registry on the filesystem — a mounted share, an offline mirror, a test's temporary folder.
 * `fetch` refuses any scheme but http and https, so the case is answered before it is asked. The
 * Java and Python implementations accept the same addresses, which is what lets one shared fixture
 * exercise the pack commands in all three without a network.
 */
function readLocal(url: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(fileURLToPath(url)));
  } catch (err) {
    throw new PackError(`cannot read ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchText(url: string): Promise<string> {
  if (url.startsWith('file:')) return Buffer.from(readLocal(url)).toString('utf8');
  const res = await fetch(url);
  if (!res.ok)
    throw new PackError(`fetch ${url} failed: HTTP ${String(res.status)} ${res.statusText}`);
  return res.text();
}

/** Fetch the registry catalogue. */
export async function fetchIndex(registry: string): Promise<PackIndex> {
  return parseIndex(await fetchText(`${registry}/index.json`));
}

/**
 * Download a URL to memory, reporting progress. `onProgress(received, total)` is
 * called as bytes arrive; `total` is 0 when the server sends no Content-Length.
 */
export async function downloadWithProgress(
  url: string,
  onProgress: (received: number, total: number) => void,
): Promise<Uint8Array> {
  if (url.startsWith('file:')) {
    const local = readLocal(url);
    onProgress(local.length, local.length);
    return local;
  }
  const res = await fetch(url);
  if (!res.ok)
    throw new PackError(`download ${url} failed: HTTP ${String(res.status)} ${res.statusText}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, buf.length);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    received += chunk.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Read a bundle zip and decide, before a single byte is written, what it would
 * put where.
 *
 * The archive nests everything under `<id>/packs/`, which is the bundler's
 * business and not the user's: those two levels are stripped here so the address
 * path lands directly in the store and `ru/person/lastName.txt` is what appears
 * under it, not `ru/packs/ru/person/lastName.txt`. Every entry must carry that
 * prefix — an archive that is not the bundle it claims to be, or that carries
 * something beside its packs, is refused whole rather than scattered into a
 * shared tree that nothing could then take apart again.
 */
async function planExtract(
  data: Uint8Array,
  id: string,
  store: string,
): Promise<{ rels: string[]; files: Record<string, Uint8Array> }> {
  const { unzipSync } = await import('fflate');
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch (err) {
    throw new PackError(`bundle "${id}" is not a valid zip: ${(err as Error).message}`);
  }
  const prefix = `${id}/${BUNDLE_PACKS_DIR}/`;
  const files: Record<string, Uint8Array> = {};
  const rels: string[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/')) continue; // directory entry
    if (!name.startsWith(prefix)) {
      throw new PackError(
        `bundle "${id}" carries "${name}", which is not under "${prefix}" — refusing to unpack it`,
      );
    }
    const rel = name.slice(prefix.length);
    if (rel === '') continue;
    // Zip-slip, checked here rather than at the write: an archive with one
    // escaping path must not first lay down the files that came before it.
    if (!isPathInside(join(store, rel), store)) {
      throw new PackError(`bundle "${id}" contains an unsafe path: ${rel}`);
    }
    files[rel] = bytes;
    rels.push(rel);
  }
  if (rels.length === 0) {
    throw new PackError(`bundle "${id}" has no files under "${prefix}"`);
  }
  return { rels: rels.sort(), files };
}

/** Write a planned extract into the store. Every path was checked by the plan. */
function writeExtract(files: Record<string, Uint8Array>, store: string): void {
  for (const [rel, bytes] of Object.entries(files)) {
    const dest = join(store, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}

/** Delete the paths a bundle owns, and any parent left empty behind them. */
function deleteOwnedPaths(store: string, paths: readonly string[]): void {
  for (const rel of paths) {
    const target = join(store, rel);
    // The record is a file on disk and may have been edited; a path that does
    // not resolve inside the store is not deleted on its say-so.
    if (!isPathInside(target, store) || target === store) {
      throw new PackError(`refusing to delete "${rel}": it is not inside the pack store`);
    }
    rmSync(target, { recursive: true, force: true });
    pruneEmptyDirs(dirname(target), store);
  }
}

// ── install one bundle ────────────────────────────────────────────────────────

interface InstallResult {
  readonly id: string;
  readonly files: number;
  readonly registered: boolean;
  readonly storedPath: string;
  /** Store-relative paths the bundle now owns — where its data actually is. */
  readonly paths: readonly string[];
}

/**
 * Download, verify, extract, and record one bundle. `report` receives a
 * single-line status the caller can render however it likes.
 */
async function installBundle(
  registry: string,
  store: Store,
  bundle: PackBundle,
  report: (line: string) => void,
): Promise<InstallResult> {
  mkdirSync(store.path, { recursive: true });

  const url = `${registry}/${bundle.file}`;
  const data = await downloadWithProgress(url, (received, total) => {
    report(progressLine(bundle.id, received, total));
  });

  // Length first: a download cut short in transit is the common case, and saying how short says
  // far more than "the hash did not match". The digest then covers everything else — including an
  // archive swapped for one of exactly the same size.
  if (bundle.bytes > 0 && data.length !== bundle.bytes) {
    throw new PackError(
      `bundle "${bundle.id}": expected ${String(bundle.bytes)} bytes, got ${String(data.length)}`,
    );
  }

  if (!verifySha256(data, bundle.sha256)) {
    throw new PackError(
      `bundle "${bundle.id}" failed its checksum — download corrupt or tampered; not installed`,
    );
  }

  report(`${bundle.id}: extracting…`);
  const { rels, files } = await planExtract(data, bundle.id, store.path);
  const paths = bundleOwnedPaths(rels);

  const record = readInstalled(store.path);
  assertNoOverlap(bundle.id, paths, record);

  // Re-installing replaces rather than layers: without this, a bundle that
  // dropped a file would leave the old one behind for good, still answering to
  // its address.
  const previous = record.bundles.find((b) => b.id === bundle.id);
  if (previous) deleteOwnedPaths(store.path, previous.paths);

  writeExtract(files, store.path);
  writeInstalled(
    store.path,
    withBundle(record, {
      id: bundle.id,
      paths,
      version: bundle.version ?? '',
      sha256: bundle.sha256,
      files: rels.length,
    }),
  );

  const { added, stored } = addDataPath(store.configPath, store.path);
  return { id: bundle.id, files: rels.length, registered: added, storedPath: stored, paths };
}

/**
 * Refuse a bundle that would write into a path another one owns.
 *
 * The registry's bundles are axis-pure and no two of them name the same path, so
 * this never fires on the real catalogue — it fires on a hand-built or renamed
 * archive, where the alternative is two bundles interleaved in one tree and a
 * `pack remove` that takes half of the other with it.
 */
function assertNoOverlap(id: string, paths: readonly string[], record: InstalledRecord): void {
  for (const other of record.bundles) {
    if (other.id === id) continue;
    for (const mine of paths) {
      for (const theirs of other.paths) {
        if (mine === theirs || mine.startsWith(`${theirs}/`) || theirs.startsWith(`${mine}/`)) {
          throw new PackError(
            `bundle "${id}" would write into "${mine}", which "${other.id}" already owns — ` +
              `remove "${other.id}" first`,
          );
        }
      }
    }
  }
}

function progressLine(id: string, received: number, total: number): string {
  const mb = (n: number): string => (n / 1_048_576).toFixed(1);
  if (total > 0) {
    const pct = Math.floor((received / total) * 100);
    return `${id}: downloading ${mb(received)}/${mb(total)} MB (${String(pct)}%)`;
  }
  return `${id}: downloading ${mb(received)} MB`;
}

// ── non-interactive commands ──────────────────────────────────────────────────

/** Where a description starts: two spaces, the id column, a space. */
/**
 * The narrowest the id column ever gets: two spaces, twelve, a space.
 *
 * It grows to fit the widest id in the catalogue — `sao_tome_and_principe` is
 * twenty-one characters, and a fixed twelve pushed every column after it out of
 * line on that row alone. It never shrinks below this, so a short catalogue keeps
 * the shape the shared CLI fixture pins.
 */
const MIN_ID_WIDTH = 12;

/**
 * Text folded to the terminal, with every line under the same indent.
 *
 * Descriptions run to two hundred characters. Printed as one line each they wrap wherever the
 * window happens to end and the remainder lands hard against the left margin, which turns a list
 * of a hundred packs into a wall nobody can read down. Off a terminal there is no width to ask
 * for, so 80 is assumed — the same answer every implementation gives, which keeps their output
 * identical when it is piped.
 */
function wrap(text: string, indent: number): readonly string[] {
  const width = Math.max(40, process.stdout.columns || 80) - indent;
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((w) => w !== '')) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(pad + line);
      line = word;
    }
  }
  if (line !== '') lines.push(pad + line);
  return lines;
}

async function cmdList(registry: string, store: Store): Promise<number> {
  const index = await fetchIndex(registry);
  const installed = new Set(installedBundleIds(store.path));
  if (index.bundles.length === 0) {
    process.stdout.write('No bundles in the registry.\n');
    return 0;
  }
  const idWidth = Math.max(MIN_ID_WIDTH, ...index.bundles.map((b) => b.id.length));
  // Two spaces of margin, the id column, one space — where a description and the
  // "installed" mark both start.
  const indent = 2 + idWidth + 1;

  process.stdout.write('Available data packs:\n\n');
  for (const b of index.bundles) {
    const mark = installed.has(b.id) ? '✓ installed' : ' ';
    const mb = (b.bytes / 1_048_576).toFixed(1);
    process.stdout.write(`  ${b.id.padEnd(idWidth)} ${mark.padEnd(12)} ${b.name} (${mb} MB)\n`);
    for (const line of wrap(b.description, indent)) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write('\n');
  }

  // An id in the store that the registry no longer lists still works; saying so beats a silent
  // omission that reads like the pack is gone.
  const listed = new Set(index.bundles.map((b) => b.id));
  const orphans = [...installed].filter((id) => !listed.has(id)).sort();
  if (orphans.length > 0) {
    process.stdout.write(`Installed but not in this registry: ${orphans.join(', ')}\n\n`);
  }

  process.stdout.write('Install with: tdcv2 pack add <id>\n');
  return 0;
}

/** Where a bundle's data ended up, for the line that reports an install. */
function installedAt(store: string, paths: readonly string[]): string {
  return paths.map((p) => join(store, p)).join(', ');
}

async function cmdAdd(registry: string, store: Store, ids: readonly string[]): Promise<number> {
  const index = await fetchIndex(registry);
  const bundles = ids.map((id) => findBundle(index, id)); // validate all first
  for (const bundle of bundles) {
    const result = await installBundle(registry, store, bundle, rewriteLine);
    endLine();
    process.stdout.write(
      `Installed ${result.id}: ${String(result.files)} files → ${installedAt(store.path, result.paths)}\n` +
        (result.registered
          ? `  registered ${result.storedPath} in ${store.configPath}\n`
          : `  already registered in ${store.configPath}\n`),
    );
  }
  return 0;
}

/**
 * Uninstall bundles: delete exactly the paths the store recorded for each, and
 * drop the store from the config once nothing is left in it. No network.
 *
 * Deleting by record rather than by folder name is what a shared tree costs and
 * what it buys: `russia` lives at `countries/russia` beside `countries/usa`, and
 * only the recorded path goes. Because installs SHADOW the bundled default
 * rather than replacing it, removing a bundle simply lets the default resurface
 * — no hole.
 */
function cmdRemove(store: Store, ids: readonly string[]): number {
  let record = readInstalled(store.path);
  for (const id of ids) {
    const entry = record.bundles.find((b) => b.id === id);
    if (entry === undefined) {
      process.stderr.write(`tdcv2: "${id}" is not installed — nothing to remove\n`);
      continue;
    }
    deleteOwnedPaths(store.path, entry.paths);
    record = withoutBundle(record, id);
    writeInstalled(store.path, record);
    process.stdout.write(`Removed ${id} (${installedAt(store.path, entry.paths)})\n`);
  }

  // The store stays registered while it still holds something: one entry serves
  // every bundle, so it only comes out when the last one does.
  if (record.bundles.length === 0 && removeDataPath(store.configPath, store.path).removed) {
    process.stdout.write(
      `  store now empty — unregistered ${store.path} from ${store.configPath}\n`,
    );
  }
  return 0;
}

/**
 * Move a store written by an older tdcv2 to the flat layout, and say what moved.
 *
 * On stderr: `pack list` prints a catalogue people pipe, and a one-off notice
 * about the store is not part of it.
 */
function reportMigration(m: StoreMigration): void {
  const lines = [
    `tdcv2: pack store "${m.store}" used the old per-bundle layout; moved it to the flat one.`,
  ];
  for (const move of m.moves) {
    lines.push(`  ${move.id}: ${move.from} → ${move.to.join(', ')} (${String(move.files)} files)`);
  }
  if (m.droppedDataPaths > 0) {
    lines.push(`  dropped ${String(m.droppedDataPaths)} per-bundle dataPaths entries`);
  }
  if (m.registered !== undefined) lines.push(`  registered ${m.registered} instead`);
  if (m.leftovers.length > 0) {
    const shown = m.leftovers.slice(0, 3).join(', ');
    const more = m.leftovers.length > 3 ? `, … and ${String(m.leftovers.length - 3)} more` : '';
    lines.push(`  left where they were (not pack data): ${shown}${more}`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

// ── interactive picker ────────────────────────────────────────────────────────

/**
 * The catalogue, browsed rather than listed.
 *
 * The picker itself only decides; installing and removing stay here, so the digests, the progress
 * line and the config writing live in one place whether the ids were typed or pointed at.
 */
async function runInteractive(registry: string, store: Store): Promise<number> {
  const index = await fetchIndex(registry);
  if (index.bundles.length === 0) {
    process.stdout.write('No bundles in the registry.\n');
    return 0;
  }

  const { runPicker } = await import('./pack-picker.js');
  const decision = await runPicker(index.bundles, new Set(installedBundleIds(store.path)));
  if (decision === null) return 0;

  if (decision.remove.length > 0) cmdRemove(store, decision.remove);

  for (const id of decision.install) {
    const bundle = findBundle(index, id);
    const result = await installBundle(registry, store, bundle, rewriteLine);
    endLine();
    process.stdout.write(
      `Installed ${result.id}: ${String(result.files)} files → ${installedAt(store.path, result.paths)}\n` +
        (result.registered
          ? `  registered ${result.storedPath} in ${store.configPath}\n`
          : `  already registered in ${store.configPath}\n`),
    );
  }

  if (decision.install.length === 0 && decision.remove.length === 0) {
    process.stdout.write('Nothing selected.\n');
  }
  return 0;
}

// ── a single rewritable status line on stderr ────────────────────────────────

let lineOpen = false;
function rewriteLine(text: string): void {
  process.stderr.write(`\r\x1b[K${text}`);
  lineOpen = true;
}
function endLine(): void {
  if (lineOpen) {
    process.stderr.write('\n');
    lineOpen = false;
  }
}

// ── entry ─────────────────────────────────────────────────────────────────────

interface PackArgs {
  readonly sub: string | undefined;
  readonly ids: readonly string[];
  readonly registry: string;
}

function parsePackArgs(argv: readonly string[]): PackArgs {
  let registry = DEFAULT_REGISTRY;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--registry') registry = argv[++i] ?? registry;
    else if (a?.startsWith('--registry=')) registry = a.slice('--registry='.length);
    else if (a !== undefined) rest.push(a);
  }
  return { sub: rest[0], ids: rest.slice(1), registry: registry.replace(/\/+$/, '') };
}

/** Run `tdcv2 pack`. Returns a process exit code. */
export async function runPack(argv: readonly string[], ctx: PackContext): Promise<number> {
  // Before the store is resolved: `pack --help` is the one thing that has to
  // work on a machine where `init` has not run yet, and resolving the store is
  // exactly what fails there. Answered ahead of the argument parser too, so
  // `-h` cannot end up read as a subcommand.
  if (argv.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const args = parsePackArgs(argv);

  let store: Store;
  try {
    store = resolveStore(ctx);
  } catch (err) {
    process.stderr.write(`tdcv2: ${(err as Error).message}\n`);
    return 2;
  }

  // isTTY is typed `boolean` but is `undefined` off a terminal; either way the
  // menu only opens with no subcommand and a real stdin+stdout TTY.
  // TDCV2_NO_PICKER turns the picker off deliberately: for a script that wants the printed list,
  // and for anyone who would rather not be dropped into a full-screen program.
  const interactive =
    args.sub === undefined &&
    process.env['TDCV2_NO_PICKER'] === undefined &&
    process.stdin.isTTY &&
    process.stdout.isTTY;

  try {
    // Before anything reads the store: a store from an older tdcv2 is in the old
    // per-bundle layout, which `list`, `add` and `remove` all now misread. The
    // first `tdcv2 pack` after an upgrade fixes it, once, and says what it did.
    const migration = migrateStore(store.path, store.configPath);
    if (migration) reportMigration(migration);

    if (interactive) return await runInteractive(args.registry, store);
    if (args.sub === 'list') return await cmdList(args.registry, store);
    if (args.sub === 'add') {
      if (args.ids.length === 0) {
        process.stderr.write('tdcv2: `pack add` needs at least one bundle id\n');
        return 2;
      }
      return await cmdAdd(args.registry, store, args.ids);
    }
    if (args.sub === 'remove') {
      if (args.ids.length === 0) {
        process.stderr.write('tdcv2: `pack remove` needs at least one bundle id\n');
        return 2;
      }
      return cmdRemove(store, args.ids);
    }
    if (args.sub === undefined) {
      // No TTY and no subcommand: show the list so the command is still useful.
      return await cmdList(args.registry, store);
    }
    process.stderr.write(`tdcv2: unknown pack command "${args.sub}" (use list | add | remove)\n`);
    return 2;
  } catch (err) {
    endLine();
    if (isPromptCancel(err)) {
      process.stderr.write('tdcv2: cancelled\n');
      return 1;
    }
    process.stderr.write(`tdcv2: ${(err as Error).message}\n`);
    return 2;
  }
}

/** Inquirer throws an ExitPromptError on Ctrl-C; recognise it by name. */
function isPromptCancel(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}
