/**
 * The `name` a `<sequence>`/`<mix>`/`<switch>` declares, and its `parent`.
 *
 * Extracted from validate.ts to keep that file under its 1000-line ceiling —
 * the same move that carved out template-locale.ts, and the same shape: a
 * narrow context interface, diagnostics pushed, nothing returned.
 */

import type { AttrContext, OpenCloseElementContext } from '../generated/TDCParser.js';

import { attrValueRange, nodeRange } from '../errors/source-map.js';
import { formatCandidates } from '../errors/suggestions.js';
import { extractAttrs } from '../processor/walk.js';
import { checkParentRef } from './parent-ref.js';
import { RESERVED_SEQUENCE_NAMES } from './known.js';

import type { Diagnostic } from '../errors/diagnostic.js';

/** What this check needs from the validator's context. */
export interface DeclNameCtx {
  readonly diagnostics: Diagnostic[];
  readonly declaredSequences: string[];
  readonly valuelessSequences: string[];
  readonly finiteValues: Map<string, readonly string[]>;
}

/** The attribute node named `name`, for a diagnostic that points at its value. */
function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}

/**
 * Validate the `name` (required, unique, non-builtin, non-`_`-prefixed) and
 * `parent` (declared earlier) attributes shared by `<sequence>` and `<mix>` —
 * both declare a named env-level value. Pushes diagnostics only; the caller
 * registers the name into `ctx.declaredSequences` afterwards.
 */
export function checkDeclName(
  el: OpenCloseElementContext,
  ctx: DeclNameCtx,
  tag: 'sequence' | 'mix' | 'switch',
): void {
  const attrs = el.attr();
  const attrMap = extractAttrs(attrs);
  const name = attrMap['name'];
  const nameAttr = findAttr(attrs, 'name');

  if (!name) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(el),
      message: `<${tag}> is missing a required "name" attribute`,
      hint: `Every ${tag} needs a unique name for interpolation, e.g. <${tag} name="Gender">.`,
      code: 'TDC030',
    });
  } else if (nameAttr) {
    if (ctx.declaredSequences.includes(name)) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(nameAttr),
        message: `duplicate sequence name "${name}"`,
        hint: 'Each <sequence>/<mix> must declare a unique name; rename or remove the duplicate.',
        code: 'TDC032',
      });
    } else if (RESERVED_SEQUENCE_NAMES.includes(name)) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(nameAttr),
        message: `sequence name "${name}" collides with a builtin`,
        hint: `Builtins: ${formatCandidates(RESERVED_SEQUENCE_NAMES)}. Pick a different name.`,
        code: 'TDC033',
      });
    } else if (name.startsWith('_')) {
      // Only warn about reserved prefix when it isn't already a harder
      // error (collision / duplicate) — avoid double-reporting the same token.
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(nameAttr),
        message: `sequence name "${name}" starts with "_" — reserved for builtins`,
        hint: `Builtin names: ${formatCandidates(RESERVED_SEQUENCE_NAMES)}. User sequences should avoid the leading underscore.`,
        code: 'TDC031',
      });
    }
  }

  checkParentRef(el, {
    diagnostics: ctx.diagnostics,
    declared: ctx.declaredSequences,
    valueless: ctx.valuelessSequences,
    finiteValues: ctx.finiteValues,
  });
}
