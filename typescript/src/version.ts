/**
 * Runtime and DSL compatibility version helpers.
 *
 * `VERSION` is the TypeScript package/runtime version surfaced by the
 * public API and CLI. TDC documents may declare `<tdc version="...">`
 * or the short `<tdc v="...">`; values above this runtime version are
 * rejected so older binaries do not silently process newer DSL dialects.
 */

export const VERSION = '0.1.0';

export const SUPPORTED_DSL_VERSION = VERSION;

export type VersionComparison = -1 | 0 | 1;

export function isVersionString(value: string): boolean {
  return /^\d+(?:\.\d+)*$/.test(value.trim());
}

export function compareVersions(left: string, right: string): VersionComparison {
  const a = versionParts(left);
  const b = versionParts(right);
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function versionParts(value: string): number[] {
  return value
    .trim()
    .split('.')
    .map((part) => Number(part));
}
