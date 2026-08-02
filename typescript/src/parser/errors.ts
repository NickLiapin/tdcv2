/**
 * Parser-related error types.
 *
 * All TDC parser errors expose a `line`/`column`/`message` triple at
 * minimum so that editor tooling and CLI error reporters can point
 * directly at the offending location in the source DSL.
 *
 * Numbering: `line` is 1-based (matching ANTLR's convention and editor
 * conventions); `column` is 0-based (matching ANTLR's convention) — users
 * converting to a 1-based column for display should add 1.
 */

export interface ParserDiagnostic {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly source: 'lexer' | 'parser';
}

/**
 * Thrown by `parseStrict`, which is the single-error "fail fast" variant
 * of the parser. Callers that prefer to gather every diagnostic in one
 * pass should use `parse` instead and inspect `result.diagnostics`.
 */
export class TdcParseError extends Error {
  public readonly diagnostics: readonly ParserDiagnostic[];

  public constructor(diagnostics: readonly ParserDiagnostic[]) {
    const summary = diagnostics
      .map((d) => `[${d.source}] line ${String(d.line)}, col ${String(d.column)}: ${d.message}`)
      .join('\n');
    super(
      diagnostics.length === 1
        ? summary
        : `Parsing failed with ${String(diagnostics.length)} diagnostics:\n${summary}`,
    );
    this.name = 'TdcParseError';
    this.diagnostics = diagnostics;
  }
}
