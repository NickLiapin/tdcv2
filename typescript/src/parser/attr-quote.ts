/**
 * An attribute value as the lexer hands it over — quotes included — and the
 * text between them.
 *
 * A value is quoted with `"` or with `'` and closes with the quote it opened
 * with. Nothing inside is escaped, so the other kind of quote is how a value
 * holds one: `value='say "hi"'`.
 */

/** Whether `text` is a whole quoted value, either kind of quote. */
export function isQuotedValue(text: string): boolean {
  const open = text[0];
  return text.length >= 2 && (open === '"' || open === "'") && text.endsWith(open);
}

/** The text between the quotes, or `text` itself when it is not quoted. */
export function unquoteValue(text: string): string {
  return isQuotedValue(text) ? text.slice(1, -1) : text;
}
