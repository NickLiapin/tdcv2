/**
 * `<encode as="...">` character conversions (spec §7.5).
 *
 * Each encoding takes a single character and returns a STRING. For base36,
 * ascii, and unicode that string is the *decimal* value of the character (so
 * `'A'` under base36 is `"10"`); for hex/binary/octal it is the code point
 * rendered in that base. Folds then consume the joined digits (spec §8).
 *
 * A "character" is one Unicode code point — strings are iterated by code point
 * elsewhere, so this stays consistent and portable (no reliance on JS
 * UTF-16 `charCodeAt`).
 */

import { ComputeError } from './value.js';

export const ENCODINGS = ['base36', 'ascii', 'unicode', 'hex', 'binary', 'octal'] as const;
export type Encoding = (typeof ENCODINGS)[number];

/** Return the single code point of `ch`, or error if it is not exactly one. */
export function codePointOf(ch: string): number {
  const points = Array.from(ch);
  if (points.length !== 1) {
    throw new ComputeError(`<encode>: expected a single character, got "${ch}"`);
  }
  return ch.codePointAt(0) ?? 0;
}

/** base36 digit value: 0-9 → 0..9, A-Z / a-z → 10..35. */
function base36Value(ch: string): number {
  const cp = codePointOf(ch);
  if (cp >= 48 && cp <= 57) return cp - 48; // '0'..'9'
  if (cp >= 65 && cp <= 90) return cp - 65 + 10; // 'A'..'Z'
  if (cp >= 97 && cp <= 122) return cp - 97 + 10; // 'a'..'z'
  throw new ComputeError(`<encode as="base36">: "${ch}" is not a digit or letter`);
}

/** Encode a single character under the named system, returning a string. */
export function encodeChar(ch: string, as: string): string {
  switch (as) {
    case 'base36':
      return String(base36Value(ch));
    case 'ascii': {
      const cp = codePointOf(ch);
      if (cp >= 128) {
        throw new ComputeError(
          `<encode as="ascii">: "${ch}" is not an ASCII character (code >= 128)`,
        );
      }
      return String(cp);
    }
    case 'unicode':
      return String(codePointOf(ch));
    case 'hex':
      return codePointOf(ch).toString(16);
    case 'binary':
      return codePointOf(ch).toString(2);
    case 'octal':
      return codePointOf(ch).toString(8);
    default:
      throw new ComputeError(
        `<encode>: unknown encoding "${as}" (expected one of ${ENCODINGS.join(', ')})`,
      );
  }
}
