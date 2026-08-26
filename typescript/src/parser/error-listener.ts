/**
 * ANTLR error listener that collects lexer and parser diagnostics into
 * a shared array instead of writing them to stderr (ANTLR's default).
 *
 * A single listener instance is wired to both the lexer and the parser
 * so all diagnostics end up in one ordered collection, making
 * multi-error reporting straightforward.
 */

import {
  BaseErrorListener,
  Token,
  type ATNSimulator,
  type Parser,
  type ParserRuleContext,
  type RecognitionException,
  type Recognizer,
} from 'antlr4ng';

import type { ParserDiagnostic } from './errors.js';

/** The grammar rules that open a tag, and what the tag is called. */
const TAG_RULES: Record<string, string | undefined> = {
  openCloseElement: undefined, // read off the rule's own `name=NAME`
  dataElement: 'data',
  mapElement: 'map',
};

/**
 * The tag that was still open when the input ended.
 *
 * ANTLR's own words for this are `mismatched input '<EOF>' expecting '</data>'`
 * and `missing END_TAG at '<EOF>'` — the first names the tag in a shape a
 * reader has to decode, the second does not name it at all. The parser knows
 * which rule it was inside, and that rule carries the tag's name, so the
 * question is answerable: walk out to the nearest tag-opening rule and read it.
 *
 * `undefined` when no such rule is on the stack, in which case ANTLR's message
 * stands — a wrong guess about which tag is open would be worse than jargon.
 */
function enclosingOpenTag(parser: Parser): string | undefined {
  let ctx: ParserRuleContext | null = parser.context;
  while (ctx !== null) {
    const rule = parser.ruleNames[ctx.ruleIndex];
    if (rule !== undefined && rule in TAG_RULES) {
      const fixed = TAG_RULES[rule];
      if (fixed !== undefined) return fixed;
      // `openCloseElement : LT name=NAME attr* GT content endTag=END_TAG` — the
      // generated context keeps a labelled token under `_name`.
      const named = (ctx as unknown as { _name?: Token | null })._name;
      if (named?.text !== undefined && named.text !== '') return named.text;
      return undefined;
    }
    ctx = ctx.parent;
  }
  return undefined;
}

export class DiagnosticCollector extends BaseErrorListener {
  private readonly collected: ParserDiagnostic[] = [];

  public override syntaxError<T extends ATNSimulator>(
    recognizer: Recognizer<T>,
    offendingSymbol: Token | number | null,
    line: number,
    charPositionInLine: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    // `recognizer.ruleNames.length > 0` distinguishes parser from lexer
    // without relying on instanceof across module boundaries.
    const isParser = recognizer.ruleNames.length > 0;
    let message = msg;
    if (isParser && typeof offendingSymbol === 'object' && offendingSymbol?.type === Token.EOF) {
      const open = enclosingOpenTag(recognizer as unknown as Parser);
      if (open !== undefined) message = `<${open}> is never closed`;
    }
    this.collected.push({
      line,
      column: charPositionInLine,
      message,
      source: isParser ? 'parser' : 'lexer',
    });
  }

  public get diagnostics(): readonly ParserDiagnostic[] {
    return this.collected;
  }
}
