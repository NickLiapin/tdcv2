/**
 * Parser for a single self-describing data-pack file.
 *
 * A pack file is either:
 *   - a bare list — one value per line, no header; or
 *   - a self-describing file with a metadata header fenced by `---`
 *     lines, followed by the list body.
 *
 * Header lines are simple `key: value` pairs (no YAML/TOML dependency —
 * the project keeps its runtime deps to antlr4ng + jsep). Blank lines and
 * `#` comment lines inside the header are ignored. All header fields are
 * optional; the header itself is optional.
 *
 * Example:
 *
 *   ---
 *   description: Spanish male given names
 *   address: es.person.man.firstName
 *   locale: es
 *   ---
 *   Rodrigo
 *   Fernando
 *   Diego
 *
 * See docs/superpowers/specs/2026-07-14-data-packs-design.md.
 */

const HEADER_FENCE = '---';

export interface ParsedPackFile {
  /** True when a `---`-fenced header block was present. */
  readonly hasHeader: boolean;
  /** Parsed `key: value` header fields (lowercased keys). Empty if none. */
  readonly header: Readonly<Record<string, string>>;
  /**
   * 1-based line number where the body starts in the original file.
   * Used to attribute diagnostics to the right source line.
   */
  readonly bodyStartLine: number;
  /** Body values: each non-blank line, trimmed, in order. */
  readonly values: readonly string[];
}

/**
 * Parse the text of a pack file into its header (if any) and body values.
 * Never throws — malformed headers are surfaced by the loader as
 * diagnostics, not exceptions.
 */
export function parsePackFile(content: string): ParsedPackFile {
  const lines = content.split(/\r?\n/);

  // A header is present only when the very first non-empty line is the
  // `---` fence. Leading blank lines before the fence are tolerated.
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').trim() === '') i++;

  if ((lines[i] ?? '').trim() !== HEADER_FENCE) {
    return {
      hasHeader: false,
      header: {},
      bodyStartLine: 1,
      values: collectValues(lines, 0),
    };
  }

  // Consume the header block until the closing fence.
  const header: Record<string, string> = {};
  const headerStart = i;
  let closed = false;
  let j = i + 1;
  for (; j < lines.length; j++) {
    const raw = lines[j] ?? '';
    if (raw.trim() === HEADER_FENCE) {
      closed = true;
      break;
    }
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue; // ignore non key:value lines; loader may warn
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key.length > 0) header[key] = value;
  }

  // Unclosed header (no second fence): treat everything after the opening
  // fence as consumed header lines, body is empty. The loader flags this.
  if (!closed) {
    return {
      hasHeader: true,
      header,
      bodyStartLine: lines.length + 1,
      values: [],
    };
  }

  const bodyStartLine = j + 2; // 1-based line after the closing fence
  void headerStart;
  return {
    hasHeader: true,
    header,
    bodyStartLine,
    values: collectValues(lines, j + 1),
  };
}

/** Collect trimmed, non-blank lines from `from` to the end. */
function collectValues(lines: readonly string[], from: number): string[] {
  const out: string[] = [];
  for (let k = from; k < lines.length; k++) {
    const v = (lines[k] ?? '').trim();
    if (v.length > 0) out.push(v);
  }
  return out;
}
