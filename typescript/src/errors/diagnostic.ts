/**
 * Unified diagnostic type — used by both the parser (syntax errors) and
 * the validator (semantic errors). A diagnostic is a structured,
 * toolable description of a problem in the user's DSL: enough
 * information to format a readable error, or to surface the error in
 * an editor (LSP-style) later on.
 *
 * Line numbers are 1-based (editor convention). Columns are 0-based
 * (ANTLR convention) — formatters add 1 when displaying to users.
 *
 * When `endLine`/`endColumn` are present, the diagnostic covers a range
 * and formatters will underline it with carets. Without them, a single
 * column marker is shown.
 */

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticSource = 'lexer' | 'parser' | 'validator' | 'render' | 'pack';

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly source: DiagnosticSource;
  readonly line: number;
  readonly column: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly message: string;
  /** Additional explanation of why this is a problem. */
  readonly hint?: string;
  /** "Did you mean X?" style correction. */
  readonly suggestion?: string;
  /** Stable machine-readable code (e.g. "TDC001") for editor/LSP use. */
  readonly code?: string;
}

/** Convenience: true iff the collection contains any error-severity diagnostic. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
