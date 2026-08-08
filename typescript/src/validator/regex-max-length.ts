/**
 * `<tdc regex_max_length="…">` — the ceiling an unbounded regex quantifier gets.
 *
 * Lives beside the validator rather than inside it because it is the one check
 * that RETURNS something the rest of the walk reads: every later regex check
 * measures against this number, so it has to run first and hand its answer on.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type { OpenCloseElementContext } from '../generated/TDCParser.js';
import { extractAttrs, findAttr } from '../processor/walk.js';

import { DEFAULT_REGEX_MAX_LENGTH, parseRegexMaxLength } from '../generators/regex.js';

export function checkRootRegexMaxLength(
  tdc: OpenCloseElementContext,
  diagnostics: Diagnostic[],
): number {
  const attr = findAttr(tdc.attr(), 'regex_max_length');
  if (!attr) return DEFAULT_REGEX_MAX_LENGTH;
  const raw = extractAttrs(tdc.attr())['regex_max_length'];
  try {
    return parseRegexMaxLength(raw);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Use a positive integer, e.g. regex_max_length="64".',
      code: 'TDC096',
    });
    return DEFAULT_REGEX_MAX_LENGTH;
  }
}
