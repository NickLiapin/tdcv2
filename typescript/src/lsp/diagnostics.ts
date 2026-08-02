/**
 * The diagnostics brain: TDC source text → LSP diagnostics.
 *
 * Pure and dependency-free (beyond our own parser/validator): given the
 * current document text, parse it and validate the resulting tree, then map
 * every finding to an LSP diagnostic. This is exactly the parse+validate
 * pass the `TDC` library runs before rendering, minus the throw — an editor
 * wants to SHOW errors live, not fail.
 *
 * Pack scanning is NOT done here (it walks the filesystem — too expensive
 * per keystroke). The server scans packs once and passes their addresses in
 * via `packAddresses`, so a `template` referencing a loaded pack is not
 * flagged as unknown. Pack-file problems belong on the pack files, not on
 * the document being edited, so they are intentionally omitted.
 */

import type { DataSourceOptions } from '../data-source/index.js';
import type { Diagnostic } from '../errors/diagnostic.js';
import { parse } from '../parser/index.js';
import { validate } from '../validator/index.js';

import { toLspDiagnostic } from './convert.js';
import type { LspDiagnostic } from './types.js';

export interface DiagnosticsContext {
  /** Dotted addresses of loaded data packs — accepted as valid templates. */
  readonly packAddresses?: readonly string[];
  /** Base dir / data paths for resolving `<gen type="file" src="…">`. */
  readonly dataSources?: DataSourceOptions;
}

export function computeDiagnostics(text: string, ctx: DiagnosticsContext = {}): LspDiagnostic[] {
  const parseResult = parse(text);

  // Parser/lexer findings carry position but no rich range/code; normalise
  // to our Diagnostic shape (same as the library does before rendering).
  const parserDiagnostics: Diagnostic[] = parseResult.diagnostics.map((d) => ({
    severity: 'error',
    source: d.source,
    line: d.line,
    column: d.column,
    message: d.message,
  }));

  // Validate the best-effort tree even when parsing had issues — the
  // validator is lenient and surfaces the semantic problems an author cares
  // about (unknown gen types, bad template paths, undeclared parents, …).
  const validation = validate(parseResult.tree, {
    packAddresses: ctx.packAddresses ?? [],
    ...(ctx.dataSources ? { dataSources: ctx.dataSources } : {}),
  });

  let semantic = validation.diagnostics;
  if (parserDiagnostics.length > 0) {
    // A broken parse yields an unreliable tree. The whole-DOCUMENT structural
    // checks then fire misleadingly and span the entire file — e.g. a stray
    // tag detaches <block>, so TDC002 "no <block>" lights up all of <tdc>
    // (that's the "everything is red" flood). Drop those while syntax is
    // broken; the precise parser error plus the node-local findings (like
    // "unexpected child") already point at the real spot.
    semantic = semantic.filter((d) => !STRUCTURAL_CODES.has(d.code ?? ''));
  }

  return [...parserDiagnostics, ...semantic].map(toLspDiagnostic);
}

/** Whole-document checks that are unreliable (and floody) on a broken parse. */
const STRUCTURAL_CODES = new Set(['TDC001', 'TDC002']);
