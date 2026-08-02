/**
 * Pretty-printer for diagnostics.
 *
 * Output style is modelled after the Rust compiler / TypeScript diagnostic
 * block: a header with severity and message, a `-->` location line, the
 * offending source line with a caret underline, and optional hint/note
 * trailers. The goal is that a user pasting a single error block into
 * a chat or an issue gives enough context to be actionable on its own.
 *
 * Example output:
 *
 *   error: unknown template path "person.male.first_name"
 *    --> demo.xml:17:31
 *     |
 *  17 |     <gen type="template" value="person.male.first_name"/>
 *     |                                 ^^^^^^^^^^^^^^^^^^^^^^
 *     |
 *   help: did you mean "person.male.firstName"?
 *   note: known paths: person.male.firstName, person.female.firstName, ...
 *
 * Multi-diagnostic input is printed as a series of blocks separated by
 * blank lines, terminated with a summary count.
 */

import type { Diagnostic } from './diagnostic.js';

export interface FormatOptions {
  /**
   * Filename to print in the `-->` location prefix. Defaults to
   * `<input>` so single-file CLI invocations read naturally even when
   * the user passed a string, not a path.
   */
  readonly filename?: string;
  /**
   * Enable ANSI colouring. Off by default — the renderer has no easy
   * way to know whether stderr is a TTY; the CLI layer enables it.
   */
  readonly colors?: boolean;
}

const ANSI = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

function colorize(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * Format a single diagnostic. `source` is the original DSL text, used
 * to render the offending line with a caret. If `source` is omitted
 * (e.g. a diagnostic carrying no location context), only the header is
 * printed.
 */
export function formatDiagnostic(
  d: Diagnostic,
  source?: string,
  options: FormatOptions = {},
): string {
  const colors = options.colors ?? false;
  const filename = options.filename ?? '<input>';
  const severityColor = d.severity === 'error' ? ANSI.red : ANSI.yellow;
  const severityLabel = colorize(
    `${colorize(d.severity, severityColor, colors)}${d.code ? `[${d.code}]` : ''}`,
    ANSI.bold,
    colors,
  );

  const header = `${severityLabel}: ${d.message}`;
  const location = ` --> ${filename}:${String(d.line)}:${String(d.column + 1)}`;

  const lines: string[] = [header, location];

  if (source) {
    const snippet = renderSnippet(d, source, colors);
    if (snippet.length > 0) {
      lines.push(...snippet);
    }
  }

  if (d.suggestion) {
    lines.push(`${colorize('help', ANSI.cyan, colors)}: ${d.suggestion}`);
  }
  if (d.hint) {
    lines.push(`${colorize('note', ANSI.cyan, colors)}: ${d.hint}`);
  }

  return lines.join('\n');
}

/**
 * Format multiple diagnostics as a report. Adds a blank line between
 * each diagnostic block and a terminal summary counting errors and
 * warnings. Returns the empty string if no diagnostics are given.
 */
export function formatDiagnostics(
  diagnostics: readonly Diagnostic[],
  source?: string,
  options: FormatOptions = {},
): string {
  if (diagnostics.length === 0) return '';
  const colors = options.colors ?? false;
  const blocks = diagnostics.map((d) => formatDiagnostic(d, source, options));
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warnCount = diagnostics.length - errorCount;
  const parts: string[] = [];
  if (errorCount > 0) parts.push(`${String(errorCount)} error${errorCount === 1 ? '' : 's'}`);
  if (warnCount > 0) parts.push(`${String(warnCount)} warning${warnCount === 1 ? '' : 's'}`);
  // "aborted" only when something actually stopped. Warnings alone leave a run
  // that finished, and announcing it as aborted sends the reader looking for a
  // failure that never happened.
  const line = errorCount > 0 ? `aborted: ${parts.join(', ')}` : parts.join(', ');
  const summary = colorize(line, ANSI.bold, colors);
  return [...blocks, '', summary].join('\n\n');
}

// --- internals ---------------------------------------------------------

/**
 * The widest source excerpt a snippet will show. A generated single-line
 * config can be arbitrarily long; echoing 100 KB of it (plus as many carets)
 * buries the message it was meant to illustrate. The window keeps the carets
 * in view with context on both sides; `…` marks whichever edges were cut.
 */
const SNIPPET_WINDOW = 160;

function renderSnippet(d: Diagnostic, source: string, colors: boolean): string[] {
  const sourceLines = source.split('\n');
  const lineIdx = d.line - 1;
  if (lineIdx < 0 || lineIdx >= sourceLines.length) return [];
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const text = sourceLines[lineIdx]!;

  // Gutter width accommodates the largest line number we'll print.
  const gutterWidth = String(d.line).length;
  const gutter = (s: string): string => s.padStart(gutterWidth, ' ');
  const pipe = colorize('|', ANSI.cyan, colors);

  // Determine caret underline range on the start line.
  let caretStart = d.column;
  const sameLine = d.endLine === undefined || d.endLine === d.line;
  const caretEnd = sameLine ? Math.max(d.endColumn ?? d.column + 1, d.column + 1) : text.length;
  let caretLen = Math.max(1, caretEnd - caretStart);

  // Window an over-long line around the carets. The same formula lives in the
  // other four implementations' renderers; change them together.
  let shown = text;
  if (text.length > SNIPPET_WINDOW) {
    const from = Math.max(0, Math.min(caretStart - 40, text.length - SNIPPET_WINDOW));
    const to = from + SNIPPET_WINDOW;
    const prefix = from > 0 ? '…' : '';
    const suffix = to < text.length ? '…' : '';
    shown = prefix + text.slice(from, to) + suffix;
    caretLen = Math.max(1, Math.min(caretLen, to - caretStart));
    caretStart = caretStart - from + prefix.length;
  }

  const caretLine = ' '.repeat(caretStart) + colorize('^'.repeat(caretLen), ANSI.red, colors);

  return [
    `${gutter('')} ${pipe}`,
    `${colorize(gutter(String(d.line)), ANSI.cyan, colors)} ${pipe} ${shown}`,
    `${gutter('')} ${pipe} ${caretLine}`,
    `${gutter('')} ${pipe}`,
  ];
}
