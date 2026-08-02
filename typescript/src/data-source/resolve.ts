import { accessSync, constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
  if (src.startsWith('pkg:')) return resolvePackageSource(src.slice('pkg:'.length), options);

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

function resolvePackageSource(
  packageSource: string,
  options: DataSourceOptions,
): DataSourceResolution {
  const parsed = parsePackageSource(packageSource);
  const attempts = packageRootAttempts(options).map((root) =>
    join(root, parsed.packageName, parsed.subpath),
  );
  const existing = attempts.find(isReadableFile);
  if (existing) return { path: existing, attempts };
  throw new DataSourceResolutionError(
    `cannot resolve package data source "pkg:${packageSource}"`,
    attempts,
  );
}

function parsePackageSource(source: string): {
  readonly packageName: string;
  readonly subpath: string;
} {
  const src = source.trim();
  if (src.length === 0) throw new DataSourceResolutionError('pkg: source must not be empty');
  const parts = src.split('/').filter((part) => part.length > 0);
  const isScoped = parts[0]?.startsWith('@') ?? false;
  const packageName = isScoped ? `${parts[0] ?? ''}/${parts[1] ?? ''}` : (parts[0] ?? '');
  const subpathParts = parts.slice(isScoped ? 2 : 1);
  if (packageName.length === 0 || subpathParts.length === 0) {
    throw new DataSourceResolutionError(
      'pkg: sources must use pkg:package/path or pkg:@scope/package/path',
    );
  }
  return { packageName, subpath: join(...subpathParts) };
}

function dataPathAttempts(source: string, options: DataSourceOptions): string[] {
  const paths = options.dataPaths ?? [];
  return paths.map((path) => resolve(path, source));
}

function packageRootAttempts(options: DataSourceOptions): string[] {
  const starts = [baseDir(options), process.cwd(), ...normalizeDataPaths(options)];
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const start of starts) {
    for (const root of nodeModuleRoots(start)) {
      if (seen.has(root)) continue;
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

function nodeModuleRoots(start: string): string[] {
  const roots: string[] = [];
  let current = resolve(start);
  let done = false;
  while (!done) {
    roots.push(join(current, 'node_modules'));
    const parent = resolve(current, '..');
    if (parent === current) done = true;
    else current = parent;
  }
  return roots;
}

function normalizeDataPaths(options: DataSourceOptions): string[] {
  return (options.dataPaths ?? []).map((path) => resolve(path));
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
