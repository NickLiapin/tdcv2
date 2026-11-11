/**
 * What a backslash means once the classes (`\d`, `\w`, `\s`, …) are out of the way.
 *
 * Shared by `regex` and `advanced_regex`, whose parsers each handle their own classes and
 * backreferences and hand every other escape here. Until this file, that "every other" was
 * one `default` arm returning the escaped character as a literal — so `\x41` printed `x41`,
 * `\bINV-\d{6}\b` copied from a validator printed `bINV-123456b`, and `check` called both
 * valid. Found by the article agent.
 *
 * Three answers now, and none of them is silence:
 *
 *   `\xHH`, `\uHHHH`      the character with that code — the usual way to write one
 *   `\b \B \A \Z \z \G`   refused: a zero-width assertion asks about the text AROUND a
 *                         position, and a generated value has nothing around it
 *   any other letter      refused: an escape TDC does not know is a typo or a feature it
 *                         lacks, never the letter itself
 *
 * Punctuation stays what it always was — `\.`, `\-`, `\\`, `\[` are the character.
 */

const ZERO_WIDTH = new Set(['b', 'B', 'A', 'Z', 'z', 'G']);

/** The literal an escape stands for, or a refusal naming why it cannot be one. */
export function escapedLiteral(ch: string, fail: (message: string) => Error): string {
  if (ZERO_WIDTH.has(ch)) {
    throw fail(
      `"\\${ch}" is a zero-width assertion, and a generated value has nothing around it to ` +
        'assert — remove it',
    );
  }
  if (/^[A-Za-z]$/.test(ch)) {
    throw fail(
      `unknown escape "\\${ch}" — write the letter without the backslash, or \\xHH or \\uHHHH ` +
        'for a character by its code',
    );
  }
  return ch;
}

/**
 * `\xHH` or `\uHHHH`, the `x` or `u` already read: exactly two or four hex digits, taken
 * through `next`, which consumes one character of the pattern per call.
 */
export function hexEscape(
  kind: 'x' | 'u',
  next: () => string | undefined,
  fail: (message: string) => Error,
): string {
  const digits = kind === 'x' ? 2 : 4;
  let hex = '';
  for (let i = 0; i < digits; i++) {
    const c = next();
    if (c === undefined || !/^[0-9A-Fa-f]$/.test(c)) {
      throw fail(
        `"\\${kind}" needs exactly ${String(digits)} hex digits, as in ` +
          (kind === 'x' ? '\\x41' : '\\u0410'),
      );
    }
    hex += c;
  }
  const code = Number.parseInt(hex, 16);
  if (code >= 0xd800 && code <= 0xdfff) {
    throw fail(`"\\u${hex}" is half of a surrogate pair — write the character itself`);
  }
  return String.fromCharCode(code);
}
