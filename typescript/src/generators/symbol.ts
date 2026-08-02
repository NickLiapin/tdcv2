/**
 * Unicode symbol generator.
 *
 * Two ways to specify the character pool, then draws `length` code points
 * from it uniformly:
 *
 *   - `<gen type="symbol" alphabet="kana.hiragana" length="8"/>` — a
 *     named alphabet from the registry.
 *   - `<gen type="symbol" value="कखगघ" length="1"/>` — an inline set,
 *     spelled directly (literals + `[x-y]` ranges, any Unicode). This is
 *     the friendly path that avoids regex for "pick one of these
 *     symbols".
 *
 * Exactly one of `alphabet` / `value` must be given. To pick a whole
 * WORD from a list, use `<gen type="text">` instead — `symbol` is
 * character-level.
 */

import { CharSetError, parseCharSet } from '../unicode/charset.js';
import { randomPick } from '../prng/random.js';
import { ALPHABET_NAMES, resolveAlphabetChars } from '../unicode/alphabets.js';

import type { Generator } from './generator.js';

export const DEFAULT_SYMBOL_LENGTH = 1;
export const MAX_SYMBOL_LENGTH = 1024;

export interface SymbolGenAttrs {
  readonly alphabet?: string | undefined;
  /** Inline character set, e.g. "कखगघ" or "[a-z][0-9]". */
  readonly value?: string | undefined;
  /**
   * Characters to ADD to the base set (same grammar as `value`).
   * Useful to extend a fixed named alphabet, e.g. alphabet="latin.lower"
   * include="[0-9]".
   */
  readonly include?: string | undefined;
  /**
   * Characters to REMOVE from the set (same grammar as `value`). Applied
   * last, so exclude has the final say — `value="[a-z]" exclude="y"`
   * yields a–z without y.
   */
  readonly exclude?: string | undefined;
  readonly length?: number | string | undefined;
}

export class SymbolGeneratorError extends Error {
  public override readonly name = 'SymbolGeneratorError';
}

export function parseSymbolLength(
  raw: number | string | undefined,
  fallback = DEFAULT_SYMBOL_LENGTH,
): number {
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SYMBOL_LENGTH) {
    throw new SymbolGeneratorError(
      `symbol length must be an integer from 1 to ${String(MAX_SYMBOL_LENGTH)}, got "${String(raw)}"`,
    );
  }
  return value;
}

export function symbolGenerator(attrs: SymbolGenAttrs): Generator {
  const chars = resolveSymbolChars(attrs);
  const length = parseSymbolLength(attrs.length);
  return (count, prng) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      let value = '';
      for (let pos = 0; pos < length; pos++) value += randomPick(prng, chars);
      out[i] = value;
    }
    return out;
  };
}

/**
 * Resolve the character pool from either the inline `value` set or the
 * named `alphabet`. Exactly one must be provided.
 */
export function resolveSymbolChars(attrs: SymbolGenAttrs): readonly string[] {
  const value = attrs.value !== undefined && attrs.value.length > 0 ? attrs.value : undefined;
  const alphabet =
    attrs.alphabet !== undefined && attrs.alphabet.length > 0 ? attrs.alphabet : undefined;

  if (value !== undefined && alphabet !== undefined) {
    throw new SymbolGeneratorError(
      'symbol generator: use either "value" (inline set) or "alphabet" (named), not both',
    );
  }

  let base: readonly string[];
  if (value !== undefined) {
    const set = parseSetOrThrow(value, 'value');
    if (set.length === 0) {
      throw new SymbolGeneratorError(
        `symbol generator: value "${value}" produced an empty character set`,
      );
    }
    base = set;
  } else if (alphabet !== undefined) {
    const chars = resolveAlphabetChars(alphabet);
    if (chars === undefined) {
      throw new SymbolGeneratorError(
        `unknown alphabet "${alphabet}"; known alphabets: ${ALPHABET_NAMES.join(', ')}`,
      );
    }
    base = chars;
  } else {
    throw new SymbolGeneratorError(
      'symbol generator requires "value" (inline set like "abc" or "[a-z]") or "alphabet" (named); ' +
        `known alphabets: ${ALPHABET_NAMES.join(', ')}`,
    );
  }

  return applyIncludeExclude(base, attrs);
}

/**
 * Apply the `include` (add) and `exclude` (remove) modifiers to a base
 * set. Order: (base ∪ include) − exclude — exclude wins. Result preserves
 * order and stays de-duplicated.
 */
function applyIncludeExclude(base: readonly string[], attrs: SymbolGenAttrs): readonly string[] {
  const include = attrs.include;
  const exclude = attrs.exclude;
  if (
    (include === undefined || include.length === 0) &&
    (exclude === undefined || exclude.length === 0)
  ) {
    return base;
  }

  const seen = new Set(base);
  const chars: string[] = [...base];
  if (include !== undefined && include.length > 0) {
    for (const c of parseSetOrThrow(include, 'include')) {
      if (!seen.has(c)) {
        seen.add(c);
        chars.push(c);
      }
    }
  }

  let result = chars;
  if (exclude !== undefined && exclude.length > 0) {
    const removed = new Set(parseSetOrThrow(exclude, 'exclude'));
    result = chars.filter((c) => !removed.has(c));
  }

  if (result.length === 0) {
    throw new SymbolGeneratorError(
      'symbol generator: the character set is empty after applying include/exclude',
    );
  }
  return result;
}

function parseSetOrThrow(spec: string, label: string): string[] {
  try {
    return parseCharSet(spec);
  } catch (err) {
    if (err instanceof CharSetError) {
      throw new SymbolGeneratorError(`symbol ${label}: ${err.message}`);
    }
    throw err;
  }
}
