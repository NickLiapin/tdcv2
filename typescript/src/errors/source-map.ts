/**
 * Utilities for extracting source-position info from ANTLR parse-tree
 * nodes.
 *
 * ANTLR tokens carry 1-based line numbers (editor convention) and
 * 0-based column indices (ANTLR convention). Our `Diagnostic` type uses
 * the same convention, so these helpers mostly pass values through with
 * a bit of normalisation.
 *
 * Attribute values are a special case: the `STRING` token includes the
 * surrounding double quotes, but when we want to underline the "bad
 * thing" for the user it is nicer to point at the inside of the quotes.
 * `attrValueRange` handles that.
 */

import type { ParserRuleContext, Token } from 'antlr4ng';

import type { AttrContext } from '../generated/TDCParser.js';

export interface Pos {
  readonly line: number;
  readonly column: number;
}

export interface Range extends Pos {
  readonly endLine: number;
  readonly endColumn: number;
}

/** Position of the first token of a node. Zero-fallback for paranoia. */
export function nodePos(node: ParserRuleContext): Pos {
  const t: Token | undefined = node.start ?? undefined;
  return {
    line: t?.line ?? 1,
    column: t?.column ?? 0,
  };
}

/**
 * Full range covering the node: from the start of the first token to
 * the end of the last token. For single-line nodes this gives a clean
 * caret underline; for multi-line ones the formatter only underlines
 * the first line (which is what a Rust-style error would do anyway).
 */
export function nodeRange(node: ParserRuleContext): Range {
  const start: Token | undefined = node.start ?? undefined;
  const stop: Token | undefined = node.stop ?? start ?? undefined;

  const line = start?.line ?? 1;
  const column = start?.column ?? 0;

  if (!stop) return { line, column, endLine: line, endColumn: column + 1 };

  const endLine = stop.line;
  const text = stop.text ?? '';
  const endColumn = stop.column + text.length;
  return { line, column, endLine, endColumn };
}

/** Position of a raw ANTLR token. */
export function tokenPos(t: Token): Pos {
  return { line: t.line, column: t.column };
}

/** Range of a raw ANTLR token. */
export function tokenRange(t: Token): Range {
  const text = t.text ?? '';
  return {
    line: t.line,
    column: t.column,
    endLine: t.line,
    endColumn: t.column + text.length,
  };
}

/**
 * Range of the attribute VALUE, excluding the surrounding quotes.
 * This is what callers usually want to underline — the content inside
 * the quotes — rather than the quotes themselves.
 *
 * If the attribute has no value token (malformed), falls back to the
 * attribute's own range.
 */
export function attrValueRange(attr: AttrContext): Range {
  const valueToken: Token | undefined = attr._attrValue ?? undefined;
  if (!valueToken) return nodeRange(attr);
  const text = valueToken.text ?? '';
  // The STRING token is "..." including quotes. Underline the insides.
  const hasQuotes = text.startsWith('"') && text.endsWith('"') && text.length >= 2;
  const inside = hasQuotes ? text.slice(1, -1) : text;
  const startCol = hasQuotes ? valueToken.column + 1 : valueToken.column;
  return {
    line: valueToken.line,
    column: startCol,
    endLine: valueToken.line,
    endColumn: startCol + inside.length,
  };
}

/** Range of the attribute NAME token. */
export function attrNameRange(attr: AttrContext): Range {
  const nameToken: Token | undefined = attr._attrName ?? undefined;
  if (!nameToken) return nodeRange(attr);
  return tokenRange(nameToken);
}
