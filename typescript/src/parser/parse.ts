/**
 * Public parser entry points for the TDC DSL.
 *
 * Two variants are provided:
 *   - `parse(source)` → returns a ParseResult with tree + diagnostics.
 *     All detected errors are collected; callers decide what to do with
 *     them. Recommended for tooling (editor LSP, linter, CI reporters).
 *   - `parseStrict(source)` → throws `TdcParseError` on any diagnostic,
 *     returns the parse tree otherwise. Recommended for one-shot runs
 *     where any syntax error aborts generation anyway.
 *
 * Both variants share the same underlying pipeline (lexer → parser tree)
 * and the same error-collection logic.
 */

import { CharStream, CommonTokenStream } from 'antlr4ng';

import { TDCLexer } from '../generated/TDCLexer.js';
import { TDCParser, type DocumentContext } from '../generated/TDCParser.js';

import { DepthGuard, ElementDepthError } from './depth.js';
import { DiagnosticCollector } from './error-listener.js';
import { TdcParseError, type ParserDiagnostic } from './errors.js';
import { preprocessPairedData } from './paired-data.js';

export interface ParseResult {
  readonly tree: DocumentContext;
  readonly diagnostics: readonly ParserDiagnostic[];
}

/**
 * Parse a TDC source string. Does not throw on syntax errors — use
 * `result.diagnostics` to inspect them.
 */
export function parse(source: string): ParseResult {
  const preprocessed = preprocessPairedData(source);
  const collector = new DiagnosticCollector();

  const input = CharStream.fromString(preprocessed.source);
  const lexer = new TDCLexer(input);
  lexer.removeErrorListeners();
  lexer.addErrorListener(collector);

  const tokens = new CommonTokenStream(lexer);
  const parser = new TDCParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener(collector);
  parser.addParseListener(new DepthGuard());

  let tree: DocumentContext;
  let depthDiagnostic: ParserDiagnostic | undefined;
  try {
    tree = parser.document();
  } catch (err) {
    if (!(err instanceof ElementDepthError)) throw err;
    // Past the nesting ceiling there is no tree worth building — parsing it IS
    // the danger (input depth is stack depth). Callers that expect a tree even
    // on errors (the LSP) get the same thing garbage input gets: an empty
    // document plus the diagnostic that explains it.
    depthDiagnostic = {
      line: err.line,
      column: err.column,
      message: err.message,
      source: 'parser',
    };
    tree = emptyDocument();
  }

  return {
    tree,
    diagnostics: [
      ...preprocessed.diagnostics,
      ...collector.diagnostics,
      ...(depthDiagnostic ? [depthDiagnostic] : []),
    ],
  };
}

/** A tree with nothing in it, for when the source is refused before parsing ends. */
function emptyDocument(): DocumentContext {
  return new TDCParser(new CommonTokenStream(new TDCLexer(CharStream.fromString('')))).document();
}

/**
 * Parse a TDC source string. Throws `TdcParseError` with all collected
 * diagnostics if any lexer/parser error was raised; otherwise returns the
 * parse tree.
 */
export function parseStrict(source: string): DocumentContext {
  const result = parse(source);
  if (result.diagnostics.length > 0) {
    throw new TdcParseError(result.diagnostics);
  }
  return result.tree;
}
