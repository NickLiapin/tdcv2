/**
 * Inline character-set parser for `<gen type="symbol" value="…">`.
 *
 * Lets a user spell a set of characters directly, without reaching for
 * regular expressions — the friendly path for "pick one symbol from this
 * bunch". Any Unicode works.
 *
 * Grammar (documented in docs/user/ru/gen.md):
 *   - `[X-Y]` inside brackets = inclusive code-point range (`[a-z]`,
 *     `[0-9]`, or a Unicode range such as Cyrillic or Devanagari).
 *     Multiple ranges/literals may share one
 *     group: `[a-z0-9_]`. A `-` at the start or end of a group is a
 *     literal hyphen.
 *   - Every other character is a literal member.
 *   - Outside brackets, commas and ASCII whitespace are ignored (they are
 *     formatting separators, so `"[a-b], [0-5]"` reads nicely). To include
 *     a literal comma, space, or bracket, put it inside a group: `[,]`,
 *     `[ ]`.
 *
 * The result preserves first-seen order and removes duplicates, so it is
 * deterministic and portable (a future Python/Java port reproduces the
 * same ordered set).
 */

export class CharSetError extends Error {
  public override readonly name = 'CharSetError';
}

/** Parse an inline character-set spec into an ordered, de-duplicated list. */
export function parseCharSet(spec: string): string[] {
  const chars = Array.from(spec); // code-point aware
  const out = new Set<string>();
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === undefined) break;
    if (c === '[') {
      const end = chars.indexOf(']', i + 1);
      if (end < 0) {
        throw new CharSetError(`character set: unterminated "[" in "${spec}"`);
      }
      expandGroup(chars.slice(i + 1, end), out, spec);
      i = end + 1;
      continue;
    }
    if (c === ',' || isSeparator(c)) {
      i += 1;
      continue;
    }
    out.add(c);
    i += 1;
  }
  return [...out];
}

/** Expand the contents of one `[...]` group into `out`. */
function expandGroup(group: readonly string[], out: Set<string>, spec: string): void {
  let j = 0;
  while (j < group.length) {
    const c = group[j];
    if (c === undefined) break;
    // A range is `X - Y` where `-` is the next token and a `Y` follows it
    // (so a trailing/leading `-` stays literal).
    const hiChar = group[j + 2];
    if (group[j + 1] === '-' && hiChar !== undefined) {
      const lo = c.codePointAt(0);
      const hi = hiChar.codePointAt(0);
      if (lo === undefined || hi === undefined) {
        throw new CharSetError(`character set: bad range near "${c}" in "${spec}"`);
      }
      if (hi < lo) {
        throw new CharSetError(`character set: reversed range "${c}-${hiChar}" in "${spec}"`);
      }
      for (let cp = lo; cp <= hi; cp++) out.add(String.fromCodePoint(cp));
      j += 3;
      continue;
    }
    out.add(c);
    j += 1;
  }
}

function isSeparator(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}
