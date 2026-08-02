/**
 * The body of a `<switch>`: its `<map>` rows and the attributes of its cases.
 *
 * A `<map>` body: `KEY:VALUE` rows separated by commas.
 *
 * A row without its colon is skipped rather than refused — one malformed entry
 * in a table of two hundred should not stop the run — so it is said out loud, or
 * the lookup would quietly be missing a case nobody could see was gone.
 */

import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  MapElementContext,
  OpenCloseElementContext,
} from '../generated/TDCParser.js';
import { extractMapText } from '../processor/walk.js';

/** Validate a `<map>` body; returns the number of parsed entries. */
export function checkSwitchMap(
  mapEl: MapElementContext,
  ctx: { diagnostics: Diagnostic[] },
): number {
  const text = extractMapText(mapEl);
  let entries = 0;
  for (const rawRow of text.split(',')) {
    const row = rawRow.trim();
    if (row.length === 0) continue;
    if (!row.includes(':')) {
      ctx.diagnostics.push({
        severity: 'warning',
        source: 'validator',
        ...nodeRange(mapEl),
        message: `malformed <map> row "${row}" — expected KEY:VALUE`,
        hint: 'Each entry is KEY:VALUE, entries separated by commas, multi-key via "|" (US|CA:USD).',
        code: 'TDC136',
      });
      continue;
    }
    entries += 1;
  }
  return entries;
}

/**
 * The attributes a `<case is="…">` inside a `<switch>` may carry.
 *
 * The content of the case is walked by the validator itself, which knows what a
 * generator and a nested mix mean; this is only about the attributes, and about
 * the two that look conditional and are not.
 */
export function checkSwitchCaseAttrs(
  caseEl: OpenCloseElementContext,
  ctx: { diagnostics: Diagnostic[] },
): void {
  const caseAttrs = caseEl.attr();
  const isAttr = findAttr(caseAttrs, 'is');
  if (!isAttr) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(caseEl),
      message: '<case> inside <switch> is missing a required "is" attribute',
      hint: 'Give the match key(s): <case is="US"> or multi-key <case is="US|CA|MX">.',
      code: 'TDC137',
    });
  }
  // `if`/`default` on a switch <case> would look conditional but are ignored —
  // selection is by `is` key match. Flag them like the mix trap (TDC128).
  for (const badName of ['if', 'default'] as const) {
    const bad = findAttr(caseAttrs, badName);
    if (!bad) continue;
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(bad),
      message: `"${badName}" on <case> is not supported — <switch> selects by the "is" key, not by condition`,
      hint: 'Match keys go in `is` (e.g. is="US|CA"). For condition-driven values use <gen if="…"> in a <sequence>.',
      code: 'TDC128',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}
