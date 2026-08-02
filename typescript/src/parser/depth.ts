/**
 * A hard ceiling on element nesting.
 *
 * The parser recurses once per nested element, so input depth IS stack depth:
 * a generated or malicious document with tens of thousands of nested tags
 * takes the whole process down before any validator sees it — and in the
 * implementations without a recoverable stack overflow the process aborts
 * outright. Real configs nest a handful of levels; the ceiling sits far above
 * any legitimate document and far below any dangerous one.
 *
 * The guard is a parse listener rather than a parser subclass so every
 * implementation can use the same shape: all four ANTLR runtimes fire
 * `enterEveryRule` before the rule body recurses, which is exactly the moment
 * the 65th level is about to open and the stack is still shallow.
 */

import type { ErrorNode, ParseTreeListener, ParserRuleContext, TerminalNode } from 'antlr4ng';

import { TDCParser } from '../generated/TDCParser.js';

/** Far above any real config (they nest ~4 levels), far below a dangerous one. */
export const MAX_ELEMENT_DEPTH = 64;

/** Thrown when a document nests elements deeper than {@link MAX_ELEMENT_DEPTH}. */
export class ElementDepthError extends Error {
  public constructor(
    public readonly line: number,
    public readonly column: number,
  ) {
    super(
      `elements nested deeper than ${String(MAX_ELEMENT_DEPTH)} levels — ` +
        'refusing a runaway document',
    );
    this.name = 'ElementDepthError';
  }
}

/** Counts `element` rule entries and refuses the level past the ceiling. */
export class DepthGuard implements ParseTreeListener {
  private depth = 0;

  public enterEveryRule(node: ParserRuleContext): void {
    if (node.ruleIndex !== TDCParser.RULE_element) return;
    this.depth += 1;
    if (this.depth > MAX_ELEMENT_DEPTH) {
      throw new ElementDepthError(node.start?.line ?? 1, node.start?.column ?? 0);
    }
  }

  public exitEveryRule(node: ParserRuleContext): void {
    if (node.ruleIndex === TDCParser.RULE_element) this.depth -= 1;
  }

  public visitTerminal(_node: TerminalNode): void {
    // Only rule depth matters here.
  }

  public visitErrorNode(_node: ErrorNode): void {
    // Only rule depth matters here.
  }
}
