/**
 * Runtime and DSL compatibility version helpers.
 *
 * `VERSION` is the TypeScript package/runtime version surfaced by the
 * public API and CLI. TDC documents may declare `<tdc version="...">`
 * or the short `<tdc v="...">`; values above this runtime version are
 * rejected so older binaries do not silently process newer DSL dialects.
 */

export const VERSION = '0.1.4';

/**
 * The newest DSL dialect this runtime understands — deliberately NOT `VERSION`.
 *
 * A package version moves for a fixed error message or a rewritten README; the
 * language does not. Tying the two meant every patch release quietly raised the
 * ceiling here while the four ports stayed where the language actually was, so
 * `<tdc version="0.1.3">` ran in TypeScript and was refused with `TDC005` by
 * Python, Java, C# and Rust — the same config, five implementations, two
 * answers.
 *
 * Raise this only when the DSL itself gains something: a tag, an attribute, a
 * value a previous runtime could not have understood. Then raise it in all five
 * at once, and the shared diagnostic case will say so if one is forgotten.
 */
export const SUPPORTED_DSL_VERSION = '0.1.0';

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
