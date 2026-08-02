/**
 * `tdcv2.config.json` — where the data lives, written down instead of guessed.
 *
 * TDC used to probe for its pack directory (`bundledPacksDir()` trying one
 * layout then another) and take `--data-path` afresh on every invocation. That
 * guessing is what produced the `npm pack` race and the "wrong path" fragility.
 * A config file replaces it: paths are stated once and resolved deterministically.
 *
 * Resolution is a cascade, highest priority last (so a later level OVERRIDES an
 * earlier one for the same pack address, which is how a downloaded or project
 * pack shadows the bundled one):
 *
 *   bundled  <  global (~/.config/tdcv2)  <  project (tdcv2.config.json)  <  --flag
 *
 * `dataPaths` ACCUMULATE across levels (every root is searched); scalar settings
 * like `locale` take the value from the highest level that sets one. Paths in a
 * config file are relative to that file's own directory, the way tsconfig's are.
 *
 * Pure and parameterised (cwd/home/env passed in) so it is testable without
 * touching the real filesystem layout.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PROJECT_CONFIG_NAME = 'tdcv2.config.json';

/** The settings a config file may carry. Everything optional. */
interface RawConfig {
  readonly dataPaths?: unknown;
  readonly locale?: unknown;
  readonly packStore?: unknown;
}

export interface ResolvedConfig {
  /**
   * Data roots in LOW→HIGH priority order (the caller prepends the bundled
   * root, which is lowest of all). Absolute paths.
   */
  readonly dataPaths: readonly string[];
  /** Default locale — the highest level that set one wins. Undefined if none. */
  readonly locale: string | undefined;
  /**
   * Where `pack add` downloads bundles. Unlike `dataPaths` this is NOT a scan
   * root — bundles land in `<packStore>/<id>/` and their specific roots are
   * added to `dataPaths`, so addresses stay correct and the store itself is
   * never scanned. The highest level that sets one wins.
   */
  readonly packStore: string | undefined;
  /**
   * The config file that set the winning `packStore` — the file `pack add`
   * edits to register a downloaded bundle's root. Undefined if no packStore.
   */
  readonly packStoreSource: string | undefined;
  /** Config files that contributed, low→high, for diagnostics. */
  readonly sources: readonly string[];
}

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

export interface LoadConfigOptions {
  /** Where the run started. Relative `--data-path` flags resolve against this. */
  readonly cwd: string;
  /**
   * Where the upward search for `tdcv2.config.json` begins. Defaults to `cwd`.
   *
   * These are the same directory for `pack` and `init`, which act on wherever
   * they were run, and DIFFERENT whenever a config file is named: a `.tdc` file
   * belongs to the project it sits in, not to the shell that happened to invoke
   * it. Searching from the shell made `tdcv2 sub/users.tdc` from one directory
   * up quietly miss the project's packs and fall back to the bundled English —
   * a run that succeeds and produces the wrong data. Java and Python have
   * always searched from the file; this is what makes the four agree.
   */
  readonly searchFrom?: string | undefined;
  /** `--data-path` values from the command line (highest priority). */
  readonly flagDataPaths?: readonly string[] | undefined;
  /** `--locale` from the command line (highest priority). */
  readonly flagLocale?: string | undefined;
  /** Overrides for testing; default to the real home/platform/env. */
  readonly home?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The global (per-user) config path: `%APPDATA%\tdcv2\config.json` on Windows,
 * else `$XDG_CONFIG_HOME/tdcv2/config.json` or `~/.config/tdcv2/config.json`.
 */
export function globalConfigPath(opts: LoadConfigOptions = { cwd: '.' }): string {
  const home = opts.home ?? homedir();
  const os = opts.platform ?? platform();
  const env = opts.env ?? process.env;
  if (os === 'win32') {
    const appData = env['APPDATA'];
    const base = appData && appData.trim() !== '' ? appData : join(home, 'AppData', 'Roaming');
    return join(base, 'tdcv2', 'config.json');
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : join(home, '.config');
  return join(base, 'tdcv2', 'config.json');
}

/**
 * Walk up from `cwd` to the filesystem root looking for the nearest
 * `tdcv2.config.json`. Returns its absolute path, or undefined if none.
 */
export function findProjectConfig(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the root
    dir = parent;
  }
}

/** One config file's contribution: absolute paths + optional locale. */
interface FileConfig {
  readonly dataPaths: readonly string[];
  readonly locale: string | undefined;
  readonly packStore: string | undefined;
}

/**
 * Read and validate one config file. A malformed config is a clear ERROR, not a
 * silent skip — it is the user's file and a typo there should be seen, not
 * absorbed. `dataPaths` are resolved relative to the config file's directory.
 */
function readConfigFile(path: string): FileConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config "${path}": ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`config "${path}" is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`config "${path}" must be a JSON object`);
  }
  const raw = parsed as RawConfig;

  const base = dirname(path);
  const dataPaths: string[] = [];
  if (raw.dataPaths !== undefined) {
    if (!Array.isArray(raw.dataPaths)) {
      throw new ConfigError(`config "${path}": "dataPaths" must be an array of strings`);
    }
    for (const entry of raw.dataPaths) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new ConfigError(`config "${path}": "dataPaths" entries must be non-empty strings`);
      }
      dataPaths.push(isAbsolute(entry) ? entry : resolve(base, entry));
    }
  }

  let locale: string | undefined;
  if (raw.locale !== undefined) {
    if (typeof raw.locale !== 'string' || raw.locale.trim() === '') {
      throw new ConfigError(`config "${path}": "locale" must be a non-empty string`);
    }
    locale = raw.locale.trim();
  }

  let packStore: string | undefined;
  if (raw.packStore !== undefined) {
    if (typeof raw.packStore !== 'string' || raw.packStore.trim() === '') {
      throw new ConfigError(`config "${path}": "packStore" must be a non-empty string`);
    }
    const p = raw.packStore.trim();
    packStore = isAbsolute(p) ? p : resolve(base, p);
  }

  return { dataPaths, locale, packStore };
}

/**
 * Resolve the effective configuration by cascading global → project → flags.
 * `dataPaths` accumulate low→high; `locale` takes the highest level that sets
 * one. The bundled pack root is NOT included here — the caller prepends it as
 * the lowest priority.
 */
export function loadConfig(opts: LoadConfigOptions): ResolvedConfig {
  const dataPaths: string[] = [];
  const sources: string[] = [];
  let locale: string | undefined;
  let packStore: string | undefined;
  let packStoreSource: string | undefined;

  const globalPath = globalConfigPath(opts);
  if (existsSync(globalPath)) {
    const g = readConfigFile(globalPath);
    dataPaths.push(...g.dataPaths);
    if (g.locale !== undefined) locale = g.locale;
    if (g.packStore !== undefined) {
      packStore = g.packStore;
      packStoreSource = globalPath;
    }
    sources.push(globalPath);
  }

  const projectPath = findProjectConfig(opts.searchFrom ?? opts.cwd);
  if (projectPath !== undefined) {
    const p = readConfigFile(projectPath);
    dataPaths.push(...p.dataPaths);
    if (p.locale !== undefined) locale = p.locale; // project overrides global
    if (p.packStore !== undefined) {
      packStore = p.packStore; // project overrides global
      packStoreSource = projectPath;
    }
    sources.push(projectPath);
  }

  // Flags are highest priority. Their paths resolve against cwd, and their
  // locale wins over any config file.
  for (const flagPath of opts.flagDataPaths ?? []) {
    dataPaths.push(isAbsolute(flagPath) ? flagPath : resolve(opts.cwd, flagPath));
  }
  if (opts.flagLocale !== undefined && opts.flagLocale.trim() !== '') {
    locale = opts.flagLocale.trim();
  }

  return { dataPaths, locale, packStore, packStoreSource, sources };
}
