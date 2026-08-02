/**
 * Validation for the `<mix flag="NAME">` / `<case anomaly="true">` pair — the
 * ground-truth label saying which rows came from a branch declared anomalous.
 *
 * Either half alone is silently useless: the config reads as if it labels
 * outliers while the runtime does nothing. That is the same trap TDC128 exists
 * for (conditional attributes on `<case>` that were accepted and ignored), so
 * it gets the same treatment — surface it rather than produce a dataset whose
 * labels are quietly all `false`.
 */

import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type { AttrContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

function isMarked(caseEl: OpenCloseElementContext): boolean {
  return (extractAttrs(caseEl.attr())['anomaly'] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Check one `<mix>`'s flag wiring. `named` is false for a nested (anonymous)
 * mix inside a `<case>`, which contributes only a value fragment and therefore
 * cannot own a sequence of its own.
 */
export function checkMixFlag(
  mixEl: OpenCloseElementContext,
  cases: readonly OpenCloseElementContext[],
  diagnostics: Diagnostic[],
  named: boolean,
): void {
  const flagAttr = findAttr(mixEl.attr(), 'flag');
  const marked = cases.filter(isMarked);

  if (flagAttr && !named) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(flagAttr),
      message:
        '"flag" on a nested <mix> is not supported — only a named env-level <mix> can declare one',
      hint: 'A flag becomes its own sequence, so it needs a <mix name="…"> at env level.',
      code: 'TDC203',
    });
    return;
  }

  if (flagAttr && marked.length === 0) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(flagAttr),
      message: 'flag="…" but no <case> is marked anomaly="true" — the column would be all "false"',
      hint: 'Mark the outlier branch: <case anomaly="true">…</case>.',
      code: 'TDC202',
    });
  }

  if (!flagAttr && marked.length > 0) {
    const bad = findAttr(marked[0]?.attr() ?? [], 'anomaly');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(bad ? attrValueRange(bad) : nodeRange(mixEl)),
      message: 'anomaly="true" on <case> does nothing — the enclosing <mix> declares no flag="…"',
      hint: 'Name the ground-truth column: <mix name="…" flag="IsAnomaly">.',
      code: 'TDC203',
    });
  }
}
