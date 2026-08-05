/**
 * Walking a container's body and naming what does not belong in it.
 *
 * Three containers used to accept an invented tag without a word — the body of
 * `<gen>`, a `<distinct>`/`<uniq>` wrapper, and (elsewhere) `<pool>` and the
 * fixtures. The walk is the same each time and only the allowed list differs,
 * so it lives here once rather than four times in `validate.ts`.
 *
 * `<data>` is never walked. A tag inside it is output TEXT —
 * `<data>x<b/>y</data>` renders `x<b/>y` — which is how a config emits XML or
 * HTML, and refusing it would take that away to catch a typo.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind } from '../processor/walk.js';

import { KNOWN_GEN_CHILDREN } from './known.js';
import { childNode, childTagName, reportUnknownChild } from './placement.js';

/** Report every child of `el` that is not on `allowed`. */
export function checkContainedTags(
  el: OpenCloseElementContext,
  parent: string,
  allowed: readonly string[],
  sink: { diagnostics: Diagnostic[] },
): void {
  for (const child of contentElements(el.content())) {
    const name = childTagName(child);
    if (name === null || allowed.includes(name)) continue;
    const node = childNode(child);
    if (node) reportUnknownChild(node, parent, name, 'TDC010', sink, allowed);
  }
}

/**
 * The open/close form of `<gen>` has a body, and everything but `<data>` in it
 * was ignored. The self-closing form has none, so it is nothing to check.
 */
export function checkGenBody(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  sink: { diagnostics: Diagnostic[] },
): void {
  if (!('content' in gen)) return;
  checkContainedTags(gen, 'gen', KNOWN_GEN_CHILDREN, sink);
}

/**
 * A `<distinct>`/`<uniq>` wrapper's own body, whichever level it sits at — the
 * caller supplies the list, because the two levels hold different things: the
 * FIELDS of one record inside a `<sequence>`, whole COLUMNS at `<env>` level.
 */
export function checkGroupBody(
  el: { readonly node: OpenCloseElementContext } | undefined,
  tag: string,
  allowed: readonly string[],
  sink: { diagnostics: Diagnostic[] },
): void {
  if (!el) return;
  checkContainedTags(el.node, tag, allowed, sink);
}

/** The open/close node of a child element, or undefined for anything else. */
export function openChild(
  child: Parameters<typeof elementKind>[0],
): { readonly node: OpenCloseElementContext } | undefined {
  const k = elementKind(child);
  return k?.kind === 'open' ? { node: k.node } : undefined;
}
