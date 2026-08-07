/**
 * Small helpers over ANTLR parse-tree contexts.
 *
 * The generated API is verbose and nullable in places where our DSL
 * makes the value mandatory. These helpers normalise access so the
 * renderer stays readable. They also handle the one token-level bit
 * the renderer cares about: stripping quotes from attribute values.
 */

import type {
  AttrContext,
  ContentContext,
  DataElementContext,
  DataSelfClosedContext,
  DataWithBodyContext,
  ElementContext,
  MapElementContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import {
  DataWithBodyContext as DataWithBodyCtor,
  MapWithBodyContext as MapWithBodyCtor,
} from '../generated/TDCParser.js';
import { restorePairedDataText } from '../parser/paired-data.js';

import type { AttrMap } from './attrs.js';

export function elementKind(
  el: ElementContext,
):
  | { kind: 'data'; node: DataElementContext }
  | { kind: 'open'; node: OpenCloseElementContext }
  | { kind: 'self'; node: SelfClosingElementContext }
  | null {
  const data = el.dataElement();
  if (data) return { kind: 'data', node: data };
  const open = el.openCloseElement();
  if (open) return { kind: 'open', node: open };
  const self = el.selfClosingElement();
  if (self) return { kind: 'self', node: self };
  return null;
}

export function elementName(el: OpenCloseElementContext | SelfClosingElementContext): string {
  return el._name?.text ?? '';
}

export function extractAttrs(attrs: readonly AttrContext[]): AttrMap {
  const out: Record<string, string> = {};
  for (const a of attrs) {
    const name = a._attrName?.text ?? '';
    const rawValue = a._attrValue?.text ?? '';
    // STRING token includes surrounding double quotes; strip them.
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
    if (name) out[name] = value;
  }
  return out;
}

// A <data> body is static (the parse tree never changes), but the render loop
// asks for its text once PER ROW. Each DATA_TEXT token is a single character,
// so re-concatenating them every row is a top hot spot. Memoize by node — the
// cache lives and dies with the parse tree (WeakMap), and the result is
// identical across rows and across re-renders of the same document.
const dataTextCache = new WeakMap<DataElementContext, string>();

export function extractDataText(data: DataElementContext): string {
  const cached = dataTextCache.get(data);
  if (cached !== undefined) return cached;
  // Self-closing <data .../> has no body. Only <data ...>body</data>
  // contains a dataContent().
  const body = asDataWithBody(data);
  if (!body) {
    dataTextCache.set(data, '');
    return '';
  }
  const content = body.dataContent();
  const tokens = content.DATA_TEXT();
  // Each DATA_TEXT token is a single character; concatenate to restore
  // the original raw-text body.
  let out = '';
  for (const t of tokens) {
    out += t.getText();
  }
  const restored = restorePairedDataText(out);
  dataTextCache.set(data, restored);
  return restored;
}

/**
 * Node-keyed attribute cache. `extractAttrs(node.attr())` is invariant per
 * node but called every row (line `if`, inline `<gen>`), so memoize by node.
 */
const elementAttrsCache = new WeakMap<object, AttrMap>();

export function elementAttrs(node: OpenCloseElementContext | SelfClosingElementContext): AttrMap {
  const cached = elementAttrsCache.get(node);
  if (cached) return cached;
  const out = extractAttrs(node.attr());
  elementAttrsCache.set(node, out);
  return out;
}

/**
 * Return the attributes declared on a <data> tag (any variant). Both
 * labeled alternatives — `dataWithBody` and `dataSelfClosed` — expose
 * `attr()`, but the base DataElementContext does not; this helper
 * smooths that over.
 */
const dataAttrsCache = new WeakMap<DataElementContext, AttrMap>();

export function extractDataAttrs(data: DataElementContext): AttrMap {
  const cached = dataAttrsCache.get(data);
  if (cached) return cached;
  const body = asDataWithBody(data);
  const self = asDataSelfClosed(data);
  const out = body ? extractAttrs(body.attr()) : self ? extractAttrs(self.attr()) : {};
  dataAttrsCache.set(data, out);
  return out;
}

/**
 * Raw text inside a `<map>…</map>` — the compact `KEY:VALUE, …` table body.
 * Like `extractDataText`, each MAP_TEXT token is a single character.
 */
export function extractMapText(map: MapElementContext): string {
  const body = map instanceof MapWithBodyCtor ? map : undefined;
  if (!body) return '';
  let out = '';
  for (const t of body.mapContent().MAP_TEXT()) {
    out += t.getText();
  }
  return out;
}

export function asDataWithBody(data: DataElementContext): DataWithBodyContext | undefined {
  return data instanceof DataWithBodyCtor ? data : undefined;
}

export function asDataSelfClosed(data: DataElementContext): DataSelfClosedContext | undefined {
  // Using name-based duck-typing here to avoid importing a second ctor
  // just for a rare alt; the runtime class is DataSelfClosedContext.
  return data.constructor.name === 'DataSelfClosedContext'
    ? (data as DataSelfClosedContext)
    : undefined;
}

export function contentElements(content: ContentContext | null): ElementContext[] {
  if (!content) return [];
  return content.element();
}

/** Find the first openCloseElement child named `name` in a content. */
export function findChildElement(
  content: ContentContext | null,
  name: string,
): OpenCloseElementContext | undefined {
  for (const el of contentElements(content)) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === name) return k.node;
  }
  return undefined;
}

type GenElement = OpenCloseElementContext | SelfClosingElementContext;

export interface CollectedSequenceGens {
  /** All `<gen>` nodes in document order — direct and inside `<distinct>`. */
  readonly nodes: GenElement[];
  /** One entry per `<distinct>` wrapper: the `<gen>` nodes it groups. */
  readonly distinctGroups: readonly GenElement[][];
}

/**
 * Collect the `<gen>` children of a `<sequence>`, descending one level into
 * any `<distinct>…</distinct>` wrapper.
 *
 * Returns the flat gen list in document order (so PRNG-consumption order is
 * preserved) plus, for each `<distinct>` wrapper, the gens it groups. A
 * `<distinct>` with no `<gen>` children contributes no group. Only one level
 * of nesting is inspected — `<distinct>` does not nest inside `<distinct>`.
 */
export function collectSequenceGens(seq: OpenCloseElementContext): CollectedSequenceGens {
  const nodes: GenElement[] = [];
  const distinctGroups: GenElement[][] = [];
  for (const el of contentElements(seq.content())) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'open' && elementName(k.node) === 'distinct') {
      const group: GenElement[] = [];
      for (const inner of contentElements(k.node.content())) {
        const ik = elementKind(inner);
        if (!ik || ik.kind === 'data') continue;
        if (elementName(ik.node) === 'gen') {
          group.push(ik.node);
          nodes.push(ik.node);
        }
      }
      if (group.length > 0) distinctGroups.push(group);
      continue;
    }
    if (k.kind !== 'data' && elementName(k.node) === 'gen') nodes.push(k.node);
  }
  return { nodes, distinctGroups };
}

/**
 * The names of the constant fields in a `<sequence>` body.
 *
 * `<data name="source">import-2026</data>` is a field of the sequence exactly as
 * a `<gen name="…">` is, and `${{Seq.source}}` resolves to it. The validator has
 * to know about them, or it would flag a reference to one as a typo.
 */
export function dataFieldNames(seq: OpenCloseElementContext): string[] {
  const names: string[] = [];
  for (const el of contentElements(seq.content())) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data') {
      // A self-closing `<data/>` carries no body and so no constant; only the
      // paired form can name one.
      const body = asDataWithBody(k.node);
      const name = body ? extractAttrs(body.attr())['name']?.trim() : undefined;
      if (name) names.push(name);
      continue;
    }
    // `<distinct>` groups gens without changing what the body means, so a
    // constant inside one is still a field of the sequence.
    if (k.kind === 'open' && elementName(k.node) === 'distinct') {
      names.push(...dataFieldNames(k.node));
    }
  }
  return names;
}

/**
 * Whether a `<sequence>` body holds a `<data>` literal.
 *
 * A literal is what makes an otherwise-simple body compose:
 * `<gen/><data> </data><gen/>` is a full name, and the space between them is not
 * decoration.
 */
export function hasDataLiteral(seq: OpenCloseElementContext): boolean {
  for (const el of contentElements(seq.content())) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data' && extractDataText(k.node).length > 0) return true;
    if (k.kind === 'open' && elementName(k.node) === 'distinct' && hasDataLiteral(k.node)) {
      return true;
    }
  }
  return false;
}

/**
 * Attribute lookup that keeps the `AttrContext` — the node a diagnostic needs to
 * point at a position rather than at a whole element.
 *
 * Lives here beside `extractAttrs`, which answers the same question and throws
 * the position away.
 */
export function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}
