/**
 * The folders a run reads packs from, for a caller that wants to see what a
 * run would see.
 *
 * `scanPacks([bundledPacksDir()])` answers for the bundled packs alone, and
 * the npm package bundles only the English starter set. The packs a person
 * installs with `tdcv2 pack add` live in a store that `tdcv2.config.json`
 * names under `dataPaths` — the project's, or the global one — and only
 * `loadConfig` knew how to find it. So a tool asking "does this person have a
 * pack for `iban`?" got "no" for every language but English, while the CLI
 * rendered the pack without complaint. Reading `config.json` itself would mean
 * re-deriving the order (global, then project, then explicit folders) and what
 * `./packs` is relative to — and disagreeing with the engine the first time
 * either changes.
 *
 * `new TDC()` builds its list with the same two calls, so the two cannot
 * drift: `scanPacks(packRoots({ configFile }))` is the registry that run gets.
 */

import { dirname, resolve } from 'node:path';

import { loadConfig } from '../config/config.js';
import { bundledPacksDir } from '../data-pack/index.js';

export interface PackRootsOptions {
  /**
   * Where the run starts. The project config is looked for upward from here,
   * unless `configFile` names a file. Defaults to the working directory.
   */
  readonly cwd?: string;
  /**
   * The `.tdc` file the run is for. The project config is looked for upward
   * from ITS folder, as a run does: a config belongs to the project it sits in,
   * not to the shell that invoked it.
   */
  readonly configFile?: string;
  /** Further folders, as `--data-path` or the `dataPaths` option add them — last, so they win. */
  readonly dataPaths?: readonly string[];
}

/** The bundled packs first — the lowest priority — then every folder a config or a caller named. */
export function rootsOf(dataPaths: readonly string[] | undefined): string[] {
  return [bundledPacksDir(), ...(dataPaths ?? [])].filter((p): p is string => p !== undefined);
}

/** The folders listed in the global and the project `tdcv2.config.json`, in that order. */
export function configuredDataPaths(searchFrom: string, cwd: string = process.cwd()): string[] {
  return [...loadConfig({ cwd, searchFrom }).dataPaths];
}

/**
 * Every folder a run reads packs from, lowest priority first: the bundled
 * packs, the global config's `dataPaths`, the project config's, then
 * `options.dataPaths`. Hand the result to `scanPacks` to see the addresses a
 * run can use.
 */
export function packRoots(options: PackRootsOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const searchFrom =
    options.configFile === undefined ? cwd : dirname(resolve(cwd, options.configFile));
  return rootsOf([...configuredDataPaths(searchFrom, cwd), ...(options.dataPaths ?? [])]);
}
