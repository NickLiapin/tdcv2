import { accessSync, constants } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DataSourceOptions {
  readonly baseDir?: string | undefined;
  readonly dataPaths?: readonly string[] | undefined;
}

export interface DataSourceResolution {
  readonly path: string;
  readonly attempts: readonly string[];
}

export class DataSourceResolutionError extends Error {
  public constructor(
    message: string,
    public readonly attempts: readonly string[] = [],
  ) {
    super(message);
    this.name = 'DataSourceResolutionError';
  }
}

export function resolveDataSourcePath(
  source: string,
  options: DataSourceOptions = {},
): DataSourceResolution {
  const src = source.trim();
  if (src.length === 0) {
    throw new DataSourceResolutionError('data source path must not be empty');
  }

  if (src.startsWith('file://')) {
    const path = fileURLToPath(src);
    return { path, attempts: [path] };
  }

  if (isAbsolute(src)) return { path: src, attempts: [src] };
  if (src.startsWith('@data/')) return resolveDataAlias(src.slice('@data/'.length), options);

  return resolveRelativeSource(src, options);
}

export function resolveExistingDataSourcePath(
  source: string,
  options: DataSourceOptions = {},
): DataSourceResolution {
  const resolution = resolveDataSourcePath(source, options);
  const readable = resolution.attempts.find(isReadableFile);
  if (readable) return { path: readable, attempts: resolution.attempts };
  throw new DataSourceResolutionError(`cannot read data source "${source}"`, resolution.attempts);
}

function resolveRelativeSource(source: string, options: DataSourceOptions): DataSourceResolution {
  const attempts = [resolve(baseDir(options), source), ...dataPathAttempts(source, options)];
  const existing = attempts.find(isReadableFile);
  return { path: existing ?? attempts[0] ?? source, attempts };
}

function resolveDataAlias(aliasPath: string, options: DataSourceOptions): DataSourceResolution {
  const normalized = aliasPath.trim();
  if (normalized.length === 0) {
    throw new DataSourceResolutionError('@data source path must not be empty');
  }
  const attempts = dataPathAttempts(normalized, options);
  if (attempts.length === 0) {
    throw new DataSourceResolutionError('@data sources require at least one configured data path');
  }
  const existing = attempts.find(isReadableFile);
  return { path: existing ?? attempts[0] ?? normalized, attempts };
}

/**
 * The configured roots to try, HIGHEST priority first.
 *
 * `dataPaths` is assembled low to high — built-in, global config, project config,
 * `--data-path` flags — because that is the order the pack loader needs, where a
 * later root shadows an earlier one. A file lookup takes the FIRST readable
 * candidate, so reading the list as assembled hands the answer to the LOWEST
 * priority root: `--data-path ./private-data` to shadow a checked-in fixture
 * exited 0 and generated from the checked-in file, silently. The flag's own
 * `--help` and the installing-packs page both promise the opposite.
 *
 * Reversing here rather than at assembly is deliberate: the pack loader reads the
 * same list and depends on the low-to-high order.
 */
function dataPathAttempts(source: string, options: DataSourceOptions): string[] {
  const paths = options.dataPaths ?? [];
  return paths.map((path) => resolve(path, source)).reverse();
}

function baseDir(options: DataSourceOptions): string {
  return resolve(options.baseDir ?? process.cwd());
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function formatDataSourceAttempts(attempts: readonly string[]): string {
  if (attempts.length === 0) return 'No candidate paths were available.';
  return `Tried: ${attempts.join('; ')}`;
}
