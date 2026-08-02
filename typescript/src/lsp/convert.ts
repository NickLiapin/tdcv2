/**
 * Coordinate + severity conversion: our `Diagnostic` → LSP shapes.
 *
 * Our diagnostics use ANTLR conventions — `line` is 1-based, `column` is
 * 0-based, and `endColumn` (when present) is the EXCLUSIVE end column
 * (`stop.column + text.length`). LSP wants both line and character
 * 0-based, with a half-open `[start, end)` range. So: subtract 1 from
 * lines, pass columns through, and use `endColumn` directly as the
 * exclusive end. When a diagnostic has no explicit end, underline a single
 * character starting at its column.
 */

import type { Diagnostic } from '../errors/diagnostic.js';

import { Severity, type LspDiagnostic, type Range, type SeverityValue } from './types.js';

export function toLspRange(d: Diagnostic): Range {
  const startLine = Math.max(0, d.line - 1);
  const startChar = Math.max(0, d.column);
  const endLine = d.endLine !== undefined ? Math.max(0, d.endLine - 1) : startLine;
  const endChar = d.endColumn !== undefined ? Math.max(startChar, d.endColumn) : startChar + 1;
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

export function toLspSeverity(severity: Diagnostic['severity']): SeverityValue {
  return severity === 'error' ? Severity.Error : Severity.Warning;
}

/**
 * Map one of our diagnostics to an LSP diagnostic. The user-facing hint and
 * "did you mean" suggestion are folded into the message (LSP shows one
 * string per squiggle); the machine `code` is preserved for editors that
 * surface it.
 */
export function toLspDiagnostic(d: Diagnostic): LspDiagnostic {
  let message = d.message;
  if (d.suggestion) message += ` — ${d.suggestion}`;
  if (d.hint) message += `\n${d.hint}`;
  return {
    range: toLspRange(d),
    severity: toLspSeverity(d.severity),
    message,
    source: 'tdc',
    ...(d.code !== undefined ? { code: d.code } : {}),
  };
}
