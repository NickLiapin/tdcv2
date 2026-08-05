/**
 * A closing tag that does not name the element it closes.
 *
 * `openCloseElement : LT name=NAME attr* GT content endTag=END_TAG ;` — the
 * grammar accepts ANY name in the closing tag, so `<sequence>…</gen>` is a
 * structurally valid document in all five implementations and `check` calls it
 * valid. Nothing downstream compares the two names, so the mistake is not
 * caught later either: the element is built under its OPENING name and the
 * closing tag is thrown away.
 *
 * The engine already refuses the same mistake in the one place it was written
 * down — `<data pair="alpha">…</data pair="beta">` is named rather than left to
 * the lexer. This is that rule for ordinary tags.
 *
 * ── Why the parser and not the validator ─────────────────────────────────────
 * The tree really is wrong: the parser has taken `</gen>` as the end of
 * `<sequence>`, so every structural complaint after it describes a shape the
 * author did not write. That is the same reason the validator is skipped on a
 * document that did not parse.
 *
 * ── Why only the first one ───────────────────────────────────────────────────
 * A closing tag that lands on the wrong element shifts every closing tag after
 * it, so one typo can produce a mismatch per remaining level plus whatever the
 * parser's recovery makes of the leftovers. All of those describe the same
 * typo. The first is the only one the author can act on.
 *
 * The guard is a parse listener rather than a parser subclass for the reason
 * {@link DepthGuard} is: all four ANTLR runtimes fire the same hook, so the
 * four ports take this file's shape rather than four different ones.
 */

import type { ErrorNode, ParseTreeListener, ParserRuleContext, TerminalNode } from 'antlr4ng';

import { OpenCloseElementContext, TDCParser } from '../generated/TDCParser.js';

import type { ParserDiagnostic } from './errors.js';

/** `</gen>` → `gen`. Undefined for anything that is not a closing tag. */
function closingName(text: string): string | undefined {
  if (!text.startsWith('</') || !text.endsWith('>')) return undefined;
  return text.slice(2, -1);
}

/** Records the first closing tag whose name is not its element's. */
export class ClosingTagGuard implements ParseTreeListener {
  private found: ParserDiagnostic | undefined;

  public exitEveryRule(node: ParserRuleContext): void {
    if (this.found) return;
    if (node.ruleIndex !== TDCParser.RULE_openCloseElement) return;
    if (!(node instanceof OpenCloseElementContext)) return;

    const open = node._name;
    const close = node._endTag;
    // Recovery can leave either token missing or synthesised. A guess about
    // what the author meant to close is worth less than the parser's own
    // complaint about why it could not read the tag at all.
    if (!open || close?.type !== TDCParser.END_TAG) return;

    const closes = closingName(close.text ?? '');
    if (closes === undefined || closes === open.text) return;

    this.found = {
      line: close.line,
      column: close.column,
      message: `</${closes}> closes <${open.text ?? ''}>, which was opened on line ${String(open.line)}`,
      source: 'parser',
    };
  }

  public enterEveryRule(_node: ParserRuleContext): void {
    // Only the closing tag matters, and it is not read until the rule exits.
  }

  public visitTerminal(_node: TerminalNode): void {
    // Only rule exits matter here.
  }

  public visitErrorNode(_node: ErrorNode): void {
    // Only rule exits matter here.
  }

  public get diagnostic(): ParserDiagnostic | undefined {
    return this.found;
  }
}

/**
 * Put the mismatch in its place among the parser's own diagnostics, and drop
 * what the parser said after it.
 *
 * Everything the parser reports past a misplaced closing tag is reading a tree
 * that has already gone wrong — the `extraneous input '</tdc>'` at the bottom
 * of the file being the usual one. What it said BEFORE the mismatch is about a
 * part of the document the mismatch had not reached yet, so that stands.
 */
export function withClosingTagMismatch(
  diagnostics: readonly ParserDiagnostic[],
  mismatch: ParserDiagnostic | undefined,
): readonly ParserDiagnostic[] {
  if (!mismatch) return diagnostics;
  const before = diagnostics.filter(
    (d) => d.line < mismatch.line || (d.line === mismatch.line && d.column < mismatch.column),
  );
  return [...before, mismatch];
}
