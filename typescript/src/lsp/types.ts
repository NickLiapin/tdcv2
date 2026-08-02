/**
 * Minimal LSP-shaped types.
 *
 * The pure LSP "brains" (convert, diagnostics, completion) speak these
 * local types so they carry ZERO external dependencies and stay fully
 * unit-testable without a running editor. Only `server.ts` depends on the
 * real `vscode-languageserver` library and maps these 1:1 onto it — the
 * field names and enum values are deliberately identical to LSP's, so the
 * mapping is a straight pass-through.
 */

/** A zero-based line and character offset (LSP convention). */
export interface Position {
  readonly line: number;
  readonly character: number;
}

/** A half-open range `[start, end)` in zero-based coordinates. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** LSP `DiagnosticSeverity` enum values. */
export const Severity = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;
export type SeverityValue = (typeof Severity)[keyof typeof Severity];

export interface LspDiagnostic {
  readonly range: Range;
  readonly severity: SeverityValue;
  readonly message: string;
  /** Stable machine code, e.g. "TDC071". */
  readonly code?: string;
  /** Always "tdc" — lets editors group our diagnostics. */
  readonly source: string;
}

/** LSP `CompletionItemKind` subset we emit (Step 2). */
export const CompletionItemKind = {
  Field: 5,
  Property: 10,
  Value: 12,
  Keyword: 14,
  Reference: 18,
  EnumMember: 20,
} as const;
export type CompletionItemKindValue = (typeof CompletionItemKind)[keyof typeof CompletionItemKind];

export interface CompletionItem {
  readonly label: string;
  readonly kind?: CompletionItemKindValue;
  /** Short right-aligned detail (e.g. an address's description). */
  readonly detail?: string;
  /** Text inserted if it differs from `label`. */
  readonly insertText?: string;
}
