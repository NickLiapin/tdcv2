/**
 * Pretty-printer for TDC `.tdc` documents.
 *
 * Re-emits the parsed tree with consistent indentation, tidy attribute
 * spacing, inline output rows, and an aligned `<map>` table. It is built to be
 * SAFE: the formatted text must generate byte-identical output to the original
 * (guaranteed by `format.test.ts`, which renders before/after and compares).
 *
 * What is preserved verbatim:
 *   - `<data>` bodies — literal generator output (incl. `<data pair="…">`).
 *   - Comments — reinjected from the token stream by position.
 *   - Attribute order and values.
 *
 * What is normalized:
 *   - Indentation (4 spaces per level) and one element per line for structure.
 *   - A single space between attributes; no space before `>` / `/>`.
 *   - `<map>` rows: compact on one line if short, else an aligned table.
 *
 * If the document has a syntax error, formatting is refused (returns the
 * source unchanged) — never format a file we can't fully parse.
 */

import { CharStream, CommonTokenStream, type Token } from 'antlr4ng';

import { TDCLexer } from '../generated/TDCLexer.js';
import {
  TDCParser,
  type ContentContext,
  type ElementContext,
  type DataElementContext,
  type MapElementContext,
  type OpenCloseElementContext,
  type SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { DiagnosticCollector } from '../parser/error-listener.js';
import { preprocessPairedData } from '../parser/paired-data.js';
import type { AttrContext } from '../generated/TDCParser.js';
import {
  contentElements,
  elementKind,
  elementName,
  extractDataAttrs,
  extractDataText,
  extractMapText,
} from '../processor/walk.js';

const INDENT = '    ';
/** Tags whose children always go on their own indented lines. */
const BLOCK_TAGS = new Set([
  'tdc',
  'env',
  'block',
  'sequence',
  'mix',
  'switch',
  'distinct',
  'uniq',
  'before',
  'after',
  'before_block',
  'after_block',
  'delimiter_block',
  'before_line',
  'after_line',
  'delimiter_line',
]);
/** Longest an inlined element / one-line `<map>` may be before it wraps. */
const INLINE_MAX = 100;
const MAP_INLINE_MAX = 72;

interface Comment {
  readonly pos: number;
  readonly text: string;
}

interface Ctx {
  readonly lines: string[];
  readonly comments: readonly Comment[];
  idx: number; // next unconsumed comment
}

/** Format a `.tdc` source string. Returns it unchanged if it has syntax errors. */
export function formatTdc(source: string): string {
  const pre = preprocessPairedData(source);
  const collector = new DiagnosticCollector();
  const input = CharStream.fromString(pre.source);
  const lexer = new TDCLexer(input);
  lexer.removeErrorListeners();
  lexer.addErrorListener(collector);
  const tokens = new CommonTokenStream(lexer);
  const parser = new TDCParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener(collector);
  const tree = parser.document();

  if (collector.diagnostics.length > 0 || pre.diagnostics.length > 0) return source;

  const comments: Comment[] = tokens
    .getTokens()
    .filter((t) => t.type === TDCLexer.COMMENT)
    .map((t) => ({ pos: t.start, text: (t.text ?? '').trim() }));

  const ctx: Ctx = { lines: [], comments, idx: 0 };
  for (const el of tree.element()) {
    flushCommentsBefore(startPos(el), 0, ctx);
    emitElement(el, 0, ctx);
  }
  flushCommentsBefore(Number.MAX_SAFE_INTEGER, 0, ctx);

  return ctx.lines.join('\n') + '\n';
}

function startPos(el: { start: Token | null }): number {
  return el.start?.start ?? 0;
}

function flushCommentsBefore(pos: number, depth: number, ctx: Ctx): void {
  while (ctx.idx < ctx.comments.length) {
    const c = ctx.comments[ctx.idx];
    if (!c || c.pos >= pos) break;
    ctx.lines.push(INDENT.repeat(depth) + c.text);
    ctx.idx += 1;
  }
}

function emitElement(el: ElementContext, depth: number, ctx: Ctx): void {
  const mapEl = el.mapElement();
  if (mapEl) {
    emitMap(mapEl, depth, ctx);
    return;
  }
  const k = elementKind(el);
  if (!k) return;
  if (k.kind === 'data') {
    ctx.lines.push(INDENT.repeat(depth) + dataString(k.node));
    return;
  }
  if (k.kind === 'self') {
    ctx.lines.push(INDENT.repeat(depth) + `<${elementName(k.node)}${attrString(k.node)}/>`);
    return;
  }
  emitOpen(k.node, depth, ctx);
}

function emitOpen(node: OpenCloseElementContext, depth: number, ctx: Ctx): void {
  const name = elementName(node);
  const open = `<${name}${attrString(node)}>`;
  const children = contentElements(node.content());
  const pad = INDENT.repeat(depth);

  if (children.length === 0) {
    ctx.lines.push(`${pad}${open}</${name}>`);
    return;
  }

  const inline = !BLOCK_TAGS.has(name) && !hasCommentWithin(node, ctx) ? tryInlineOpen(node) : null;
  if (inline !== null && (pad + inline).length <= INLINE_MAX) {
    ctx.lines.push(pad + inline);
    return;
  }

  ctx.lines.push(pad + open);
  formatContent(node.content(), depth + 1, ctx);
  ctx.lines.push(`${pad}</${name}>`);
}

function formatContent(content: ContentContext | null, depth: number, ctx: Ctx): void {
  for (const el of contentElements(content)) {
    flushCommentsBefore(startPos(el), depth, ctx);
    emitElement(el, depth, ctx);
  }
}

/** One-line rendering of an element, or null if it must span multiple lines. */
function tryInline(el: ElementContext): string | null {
  const mapEl = el.mapElement();
  if (mapEl) return inlineMap(mapEl);
  const k = elementKind(el);
  if (!k) return '';
  if (k.kind === 'data') return dataString(k.node);
  if (k.kind === 'self') return `<${elementName(k.node)}${attrString(k.node)}/>`;
  return tryInlineOpen(k.node);
}

function tryInlineOpen(node: OpenCloseElementContext): string | null {
  const name = elementName(node);
  if (BLOCK_TAGS.has(name)) return null;
  const children = contentElements(node.content());
  const open = `<${name}${attrString(node)}>`;
  if (children.length === 0) return `${open}</${name}>`;
  let inner = '';
  for (const child of children) {
    const part = tryInline(child);
    if (part === null) return null;
    inner += part;
  }
  return `${open}${inner}</${name}>`;
}

// -----------------------------------------------------------------------
// <data>
// -----------------------------------------------------------------------

function dataString(node: DataElementContext): string {
  const attrs = attrString(node);
  const body = extractDataText(node);
  // Self-closing <data .../> has no body.
  if (isSelfClosed(node)) return `<data${attrs}/>`;
  const pair = extractDataAttrs(node)['pair'];
  const close = pair !== undefined ? `</data pair="${pair}">` : '</data>';
  return `<data${attrs}>${body}${close}`;
}

function isSelfClosed(node: DataElementContext): boolean {
  return node.constructor.name === 'DataSelfClosedContext';
}

// -----------------------------------------------------------------------
// <map>
// -----------------------------------------------------------------------

interface MapRow {
  readonly keys: string;
  readonly value: string;
}

function mapRows(mapEl: MapElementContext): MapRow[] {
  const rows: MapRow[] = [];
  for (const raw of extractMapText(mapEl).split(',')) {
    const row = raw.trim();
    if (row.length === 0) continue;
    const colon = row.indexOf(':');
    if (colon < 0) continue;
    const keys = row
      .slice(0, colon)
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
      .join('|');
    if (keys.length === 0) continue;
    rows.push({ keys, value: row.slice(colon + 1).trim() });
  }
  return rows;
}

function inlineMap(mapEl: MapElementContext): string {
  const rows = mapRows(mapEl);
  const body = rows.map((r) => `${r.keys}:${r.value}`).join(', ');
  return `<map${attrString(mapEl)}>${body}</map>`;
}

function emitMap(mapEl: MapElementContext, depth: number, ctx: Ctx): void {
  const pad = INDENT.repeat(depth);
  const rows = mapRows(mapEl);
  if (rows.length === 0) {
    ctx.lines.push(`${pad}<map${attrString(mapEl)}></map>`);
    return;
  }
  const inline = inlineMap(mapEl);
  if (rows.length <= 1 || (pad + inline).length <= MAP_INLINE_MAX) {
    ctx.lines.push(pad + inline);
    return;
  }
  // Aligned table: pad keys to the widest, `: ` separator, trailing comma
  // on all but the last row (the map extractor splits on commas).
  const keyWidth = Math.max(...rows.map((r) => r.keys.length));
  ctx.lines.push(`${pad}<map${attrString(mapEl)}>`);
  rows.forEach((r, i) => {
    const comma = i < rows.length - 1 ? ',' : '';
    ctx.lines.push(`${pad}${INDENT}${r.keys.padEnd(keyWidth)} : ${r.value}${comma}`);
  });
  ctx.lines.push(`${pad}</map>`);
}

// -----------------------------------------------------------------------
// attributes / comments
// -----------------------------------------------------------------------

function attrListOf(node: object): AttrContext[] {
  // The runtime subclasses (DataWithBody, MapWithBody, open/self) all expose
  // attr(); the base Data/Map contexts don't declare it — duck-type it.
  const fn = (node as { attr?: () => AttrContext[] }).attr;
  return typeof fn === 'function' ? fn.call(node) : [];
}

function attrString(node: object): string {
  let out = '';
  for (const a of attrListOf(node)) {
    const name = a._attrName?.text ?? '';
    let val = a._attrValue?.text ?? '';
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (name) out += ` ${name}="${val}"`;
  }
  return out;
}

function hasCommentWithin(
  node: OpenCloseElementContext | SelfClosingElementContext,
  ctx: Ctx,
): boolean {
  const from = node.start?.start ?? 0;
  const to = node.stop?.stop ?? from;
  return ctx.comments.some((c) => c.pos > from && c.pos < to);
}
