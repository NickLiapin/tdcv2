/**
 * `TdcDiagnosticError` — single error type carried across all TDC pipeline
 * failures that have a point-in-source location. Parse-time, validate-
 * time, and (where feasible) render-time errors all funnel through this
 * class, so the CLI and the library API can catch one thing and pretty-
 * print it uniformly.
 *
 * The `message` property is built from the collected diagnostics so
 * callers that just log `err.message` still get useful output; callers
 * that want the full Rust-style formatted block should call
 * `formatDiagnostics(err.diagnostics, err.source)`.
 */

import type { Diagnostic } from './diagnostic.js';

export class TdcDiagnosticError extends Error {
  public readonly diagnostics: readonly Diagnostic[];
  /** Original DSL source, when available — used by the formatter for snippets. */
  public readonly source?: string;

  public constructor(diagnostics: readonly Diagnostic[], source?: string) {
    const summary = summarize(diagnostics);
    super(summary);
    this.name = 'TdcDiagnosticError';
    this.diagnostics = diagnostics;
    if (source !== undefined) this.source = source;
  }
}

function summarize(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return 'TDC: unknown error';
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warnCount = diagnostics.length - errorCount;
  const first = diagnostics[0];
  if (!first) return 'TDC: unknown error';
  if (diagnostics.length === 1) {
    return `${first.severity}: ${first.message} (line ${String(first.line)}, col ${String(first.column + 1)})`;
  }
  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${String(errorCount)} error${errorCount === 1 ? '' : 's'}`);
  if (warnCount > 0) parts.push(`${String(warnCount)} warning${warnCount === 1 ? '' : 's'}`);
  return `${parts.join(', ')}; first: ${first.message} (line ${String(first.line)}, col ${String(first.column + 1)})`;
}
