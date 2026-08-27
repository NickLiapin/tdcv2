/**
 * The placement contract — which tag may live inside which.
 *
 * The grammar lets any element nest anywhere, so these rules live in the
 * validator. This module holds the small, reusable pieces the container
 * checks in `validate.ts` share; the full contract is pinned by
 * `test/validator/placement.test.ts`.
 */

import type { ParserRuleContext } from 'antlr4ng';

import { type Diagnostic, formatCandidates, nodeRange } from '../errors/index.js';
import { ALLOWED_CHILDREN } from './known.js';
import { closestMatch } from '../errors/index.js';
import type { ElementContext } from '../generated/TDCParser.js';
import { elementKind, elementName } from '../processor/walk.js';

/** Underlying context of any child element — incl. `<map>`, which elementKind skips. */
export function childNode(el: ElementContext): ParserRuleContext | null {
  return (
    el.mapElement() ?? el.dataElement() ?? el.openCloseElement() ?? el.selfClosingElement() ?? null
  );
}

/** Tag name of any child — `'data'`/`'map'` or the element name; null for a whitespace node. */
export function childTagName(el: ElementContext): string | null {
  if (el.mapElement()) return 'map';
  const k = elementKind(el);
  if (!k) return null;
  return k.kind === 'data' ? 'data' : elementName(k.node);
}

/** Where each construct is allowed to live — the "put it in X" hint on a placement error. */
const PLACEMENT_HINT: Record<string, string> = {
  gen: 'A <gen> lives inside a <sequence> (or a <case> of a <mix>/<switch>).',
  mix: 'A <mix> is a named env-level construct — declare it directly in <env> and use ${{Name}}.',
  switch:
    'A <switch> is a named env-level construct — declare it directly in <env> and use ${{Name}}.',
  case: 'A <case> belongs inside a <mix> or a <switch>.',
  map: 'A <map> belongs inside a <switch>.',
  default: 'A <default> belongs inside a <switch>.',
  line: 'A <line> belongs inside a <block> (or a before/after fixture).',
  sequence: 'A <sequence> belongs directly inside <env>.',
  // A <data> has no value of its own: it JOINS the value of the thing around
  // it. Written where there is nothing to join — straight into <tdc>, <env>,
  // <block> or <pool> — it rendered nothing and said nothing, which is the
  // silent loss this project refuses everywhere else.
  data:
    'A <data> joins the value of the <line>, <sequence> or <case> it sits in — ' +
    'on its own there is nothing for it to join.',
};

/** True for a known construct that simply belongs somewhere else. */
export function isKnownConstruct(name: string): boolean {
  return PLACEMENT_HINT[name] !== undefined;
}

/**
 * A `<data>` written where nothing renders it.
 *
 * `<tdc>`, `<env>`, `<block>` and `<pool>` each used to skip a `<data>` child
 * before any check ran, so the text was dropped without a word — the config
 * said something and got nothing. A `<data>` has no value of its own; it joins
 * the value of the thing around it, and those four have no value to join.
 * `<pool>` is the one worth spelling out: it publishes NAMED fields, so a tag
 * with no name could not be addressed even if it were kept.
 */
export function reportLooseData(
  el: ElementContext,
  parent: string,
  sink: { diagnostics: Diagnostic[] },
): boolean {
  if (elementKind(el)?.kind !== 'data') return false;
  reportMisplaced(el, 'data', parent, sink);
  return true;
}

/** Report a known tag sitting in a parent that doesn't allow it. */
export function reportMisplaced(
  el: ElementContext,
  name: string,
  parent: string,
  sink: { diagnostics: Diagnostic[] },
): void {
  const node = childNode(el);
  if (!node) return;
  // Two halves, and the second is the one a reader acts on: where this tag
  // SHOULD go, then what this parent WILL take. TDC013 used to carry only the
  // first — and for a tag with no entry above, only "move it somewhere".
  const belongs = PLACEMENT_HINT[name];
  // Sorted, like the unknown-child path below — the previous commit sorted only
  // one of the two and left this one printing declaration order.
  const allowed = ALLOWED_CHILDREN[parent];
  const takes = allowed
    ? `Allowed inside <${parent}>: ${formatCandidates([...allowed].sort())}.`
    : undefined;
  sink.diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(node),
    message: `<${name}> is not allowed directly inside <${parent}>`,
    hint: [belongs, takes].filter(Boolean).join(' ') || `Move <${name}> to a valid location.`,
    code: 'TDC013',
  });
}

/**
 * One invented tag, one answer — wherever it turns up.
 *
 * Eight containers refused an unknown child and five let it through in silence,
 * and the eight that did refuse used five codes and three wordings for the one
 * mistake. The codes stay as they are (they are published, and the errors
 * reference is keyed by them); the NOTE is what a reader acts on, so every
 * container now says it the same way.
 *
 * `<data>` is the deliberate exception and is never checked: a tag inside it is
 * output TEXT — `<data>x<b/>y</data>` renders `x<b/>y` — which is how a config
 * emits XML or HTML.
 */
export function reportUnknownChild(
  node: ParserRuleContext,
  parent: string,
  name: string,
  code: string,
  sink: { diagnostics: Diagnostic[] },
  /** Explicit list, for a tag whose children depend on where it sits. */
  allowedOverride?: readonly string[],
): void {
  // Sorted, because the four ports sort and a reader scanning for a name finds it
  // faster in a list that has an order. The truncation `formatCandidates` applies to a
  // long list then cuts the same names everywhere rather than a different six per
  // implementation — which is what made the difference worth closing at all.
  const allowed = [...(allowedOverride ?? ALLOWED_CHILDREN[parent] ?? [])].sort();
  const suggestion = closestMatch(name, allowed);
  sink.diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(node),
    message: `unknown child of <${parent}>: "<${name}>"`,
    ...(suggestion ? { suggestion: `did you mean "<${suggestion}>"?` } : {}),
    hint: `Allowed inside <${parent}>: ${formatCandidates(allowed)}.`,
    code,
  });
}
