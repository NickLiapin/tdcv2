/**
 * The typed output columns declared in a `<block>`.
 *
 * A `<data>` carrying a `name` is a COLUMN; one without is decorative text and
 * is ignored by columnar output. `<line>` structure is irrelevant here — the
 * columns are all named `<data>` in document order. This keeps the text block
 * and the columnar schema the same construct, so nothing new has to be learned
 * and text output is unaffected.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §1.
 */

import type { DocumentContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import {
  contentElements,
  elementKind,
  elementName,
  extractDataAttrs,
  extractDataText,
  findChildElement,
} from '../processor/walk.js';

import { parseOutputColumnType, type OutputColumnType } from './column-type.js';

export interface DeclaredColumn {
  readonly name: string;
  /** Raw `<data>` body, interpolated per row before being typed. */
  readonly template: string;
  /** Parsed `type="…"`; undefined when the attribute is absent (resolved later). */
  readonly type?: OutputColumnType;
}

function findTdc(doc: DocumentContext): OpenCloseElementContext | undefined {
  for (const el of doc.element()) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === 'tdc') return k.node;
  }
  return undefined;
}

/** Collect named `<data>` from a `<block>`/`<line>` subtree, in document order. */
function collect(
  content: ReturnType<OpenCloseElementContext['content']>,
  out: DeclaredColumn[],
): void {
  for (const el of contentElements(content)) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data') {
      const attrs = extractDataAttrs(k.node);
      const name = attrs['name'];
      if (name === undefined || name.trim() === '') continue; // decorative text
      const rawType = attrs['type'];
      let type: OutputColumnType | undefined;
      if (rawType !== undefined) {
        try {
          type = parseOutputColumnType(rawType);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`column "${name.trim()}": ${message}`);
        }
      }
      out.push({
        name: name.trim(),
        template: extractDataText(k.node),
        ...(type ? { type } : {}),
      });
      continue;
    }
    // Descend into <line> (and any other wrapper) so nesting does not matter.
    if (k.kind === 'open') collect(k.node.content(), out);
  }
}

/**
 * The columns declared by the document's `<block>`. Empty when the block is a
 * plain text template (no named `<data>`) — that is the normal, untyped path.
 * Throws on a duplicate name or an unparsable `type=`.
 */
export function extractDeclaredColumns(doc: DocumentContext): DeclaredColumn[] {
  const tdc = findTdc(doc);
  if (!tdc) return [];
  const block = findChildElement(tdc.content(), 'block');
  if (!block) return [];

  const columns: DeclaredColumn[] = [];
  collect(block.content(), columns);

  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) throw new Error(`duplicate column name "${column.name}"`);
    seen.add(column.name);
  }
  return columns;
}
