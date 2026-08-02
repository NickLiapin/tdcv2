/**
 * `tdcv2 pack` — get data packs onto disk without the user hand-managing folders
 * or paths.
 *
 * In a real terminal it opens a small menu: browse the registry, tick the
 * bundles you want, and it downloads, verifies by hash, extracts into the pack
 * store, and wires the pack folder into your config — so the data is usable by
 * its normal address the moment it lands. With no terminal it is scriptable:
 * `pack list` and `pack add <id…>`.
 *
 * The wire (fetch) and the unzip live here; the decisions (what the index means,
 * whether a download is intact, which folder to register) are pure in
 * `pack-core.ts`. Inquirer and fflate are imported lazily so the ordinary
 * generate path never pays for them.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config/config.js';
import {
  PackError,
  bundleDir,
  bundlePacksRoot,
  findBundle,
  installedBundleIds,
  isPathInside,
  parseIndex,
  registerBundleInConfig,
  unregisterBundleFromConfig,
  verifySha256,
  type PackBundle,
  type PackIndex,
} from './pack-core.js';

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
 * Extract a bundle zip into the store. The zip nests everything under its own
 * top folder (`<id>/…`), so extracting into the store places it at
 * `<store>/<id>/…`. Each entry is checked to stay under the store (zip-slip
 * guard). Returns the number of files written.
 */
async function extractBundle(data: Uint8Array, store: string, id: string): Promise<number> {
  const { unzipSync } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch (err) {
    throw new PackError(`bundle "${id}" is not a valid zip: ${(err as Error).message}`);
  }
  let written = 0;
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) continue; // directory entry
    const dest = join(store, name);
    if (!isPathInside(dest, store)) {
      throw new PackError(`bundle "${id}" contains an unsafe path: ${name}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    written++;
  }
  if (!existsSync(bundlePacksRoot(store, id))) {
    throw new PackError(`bundle "${id}" has no "packs" folder at its root — cannot register it`);
  }
  return written;
}

// ── install one bundle ────────────────────────────────────────────────────────

interface InstallResult {
  readonly id: string;
  readonly files: number;
  readonly registered: boolean;
  readonly storedPath: string;
}

/**
 * Download, verify, extract, and register one bundle. `report` receives a
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
  const files = await extractBundle(data, store.path, bundle.id);

  const { added, stored } = registerBundleInConfig(
    store.configPath,
    bundlePacksRoot(store.path, bundle.id),
  );
  return { id: bundle.id, files, registered: added, storedPath: stored };
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

async function cmdAdd(registry: string, store: Store, ids: readonly string[]): Promise<number> {
  const index = await fetchIndex(registry);
  const bundles = ids.map((id) => findBundle(index, id)); // validate all first
  for (const bundle of bundles) {
    const result = await installBundle(registry, store, bundle, rewriteLine);
    endLine();
    process.stdout.write(
      `Installed ${result.id}: ${String(result.files)} files → ${bundleDir(store.path, result.id)}\n` +
        (result.registered
          ? `  registered ${result.storedPath} in ${store.configPath}\n`
          : `  already registered in ${store.configPath}\n`),
    );
  }
  return 0;
}

/**
 * Uninstall bundles: delete `<store>/<id>` and drop its pack root from the
 * config. No network. Because installs SHADOW the bundled default rather than
 * replacing it, removing a bundle simply lets the default resurface — no hole.
 */
function cmdRemove(store: Store, ids: readonly string[]): number {
  const installed = new Set(installedBundleIds(store.path));
  for (const id of ids) {
    const dir = bundleDir(store.path, id);
    if (!installed.has(id) && !existsSync(dir)) {
      process.stderr.write(`tdcv2: "${id}" is not installed — nothing to remove\n`);
      continue;
    }
    const { removed } = unregisterBundleFromConfig(
      store.configPath,
      bundlePacksRoot(store.path, id),
    );
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write(
      `Removed ${id} (${dir})\n` +
        (removed
          ? `  unregistered from ${store.configPath}\n`
          : `  was not registered in ${store.configPath}\n`),
    );
  }
  return 0;
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
      `Installed ${result.id}: ${String(result.files)} files → ${bundleDir(store.path, result.id)}\n` +
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
