/**
 * The placement contract — which tag may live inside which.
 *
 * The grammar lets any element nest anywhere, so these rules live in the
 * validator. This module holds the small, reusable pieces the container
 * checks in `validate.ts` share; the full contract is pinned by
 * `test/validator/placement.test.ts`.
 */

import type { ParserRuleContext } from 'antlr4ng';

import { type Diagnostic, nodeRange } from '../errors/index.js';
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
};

/** True for a known construct that simply belongs somewhere else. */
export function isKnownConstruct(name: string): boolean {
  return PLACEMENT_HINT[name] !== undefined;
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
  sink.diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(node),
    message: `<${name}> is not allowed directly inside <${parent}>`,
    hint: PLACEMENT_HINT[name] ?? `Move <${name}> to a valid location.`,
    code: 'TDC013',
  });
}
