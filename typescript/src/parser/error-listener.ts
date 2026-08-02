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
  type ATNSimulator,
  type RecognitionException,
  type Recognizer,
  type Token,
} from 'antlr4ng';

import type { ParserDiagnostic } from './errors.js';

export class DiagnosticCollector extends BaseErrorListener {
  private readonly collected: ParserDiagnostic[] = [];

  public override syntaxError<T extends ATNSimulator>(
    recognizer: Recognizer<T>,
    _offendingSymbol: Token | number | null,
    line: number,
    charPositionInLine: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    // `recognizer.ruleNames.length > 0` distinguishes parser from lexer
    // without relying on instanceof across module boundaries.
    const isParser = recognizer.ruleNames.length > 0;
    this.collected.push({
      line,
      column: charPositionInLine,
      message: msg,
      source: isParser ? 'parser' : 'lexer',
    });
  }

  public get diagnostics(): readonly ParserDiagnostic[] {
    return this.collected;
  }
}
