/**
 * Compatibility checks for the root `<tdc version="...">` declaration.
 */

import { SUPPORTED_DSL_VERSION, compareVersions, isVersionString } from '../version.js';
import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type { AttrContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

export function checkDocumentVersion(
  tdc: OpenCloseElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = tdc.attr();
  const attrMap = extractAttrs(attrs);
  const longAttr = findAttr(attrs, 'version');
  const shortAttr = findAttr(attrs, 'v');

  if (longAttr && shortAttr) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(tdc),
      message: '<tdc> declares both "version" and "v"',
      hint: 'Use one root version attribute. Prefer the canonical form: <tdc version="0.1.0">.',
      code: 'TDC003',
    });
    return;
  }

  const versionAttr = longAttr ?? shortAttr;
  if (!versionAttr) return;

  const raw = attrMap[longAttr ? 'version' : 'v'] ?? '';
  if (!isVersionString(raw)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(versionAttr),
      message: `invalid TDC document version "${raw}"`,
      hint: 'Use dot-separated numeric versions, e.g. "0.1", "0.1.0", or "1.2.3".',
      code: 'TDC004',
    });
    return;
  }

  if (compareVersions(raw, SUPPORTED_DSL_VERSION) > 0) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(versionAttr),
      message: `TDC document version "${raw}" is newer than this runtime (${SUPPORTED_DSL_VERSION})`,
      hint: 'Update TDC before processing this file; newer DSL features may not exist in this runtime.',
      code: 'TDC005',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}
