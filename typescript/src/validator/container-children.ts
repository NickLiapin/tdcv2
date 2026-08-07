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
import { contentElements, elementKind, elementName } from '../processor/walk.js';
import { nodeRange } from '../errors/source-map.js';

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

/**
 * A second `<env>` or a second `<block>` under `<tdc>`.
 *
 * Both are read by taking the FIRST of their kind, so a second one is dropped
 * whole — every sequence it declares, every line it lays out — and the run
 * finishes looking healthy. `check` called such a document valid, and half the
 * config produced nothing: the same silent discard TDC014 refuses for the
 * self-closing spelling, one level up.
 *
 * Reported on the SECOND one: the first is the one that runs, so the second is
 * the surprise, and pointing at it puts the caret on the text to delete or
 * merge.
 */
export function checkOneEnvOneBlock(tdc: OpenCloseElementContext, diagnostics: Diagnostic[]): void {
  const seen = new Map<string, number>();
  for (const child of contentElements(tdc.content())) {
    const k = elementKind(child);
    if (!k || k.kind === 'data') continue;
    const name = elementName(k.node);
    if (name !== 'env' && name !== 'block') continue;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count < 2) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(k.node),
      message: `<tdc> holds more than one <${name}> — only the first is read, and this one is discarded whole`,
      hint:
        name === 'env'
          ? 'Every sequence declared here would be missing at render time. Move them into the first <env>.'
          : 'Every line laid out here would be missing from the output. Move them into the first <block>, or use <line if="…"> to switch layouts per row.',
      code: 'TDC270',
    });
  }
}
