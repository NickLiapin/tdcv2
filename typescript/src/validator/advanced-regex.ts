/**
 * Validation for `<gen type="advanced_regex">`.
 *
 * Kept outside validate.ts because that file is near the project's
 * 1000-line source limit. Advanced regex deliberately has its own
 * validation surface while the stable `regex` generator remains
 * unchanged.
 */

import { attrValueRange, nodeRange, type Diagnostic } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { parseRegexMaxLength } from '../generators/regex.js';
import { extractAttrs } from '../processor/walk.js';
import { parseAdvancedRegexProgram } from '../generators/advanced-regex.js';

interface AdvancedRegexValidationContext {
  readonly diagnostics: Diagnostic[];
  readonly regexMaxLength: number;
}

export function checkGenAdvancedRegex(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: AdvancedRegexValidationContext,
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const valueAttr = findAttr(attrs, 'value');
  if (!valueAttr) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="advanced_regex"> requires a "value" attribute',
      hint: 'Provide a finite advanced regex pattern, e.g. value="(?%{70:RU;30:US})-[0-9]{6}".',
      code: 'TDC128',
    });
    return;
  }

  const localLimitAttr = findAttr(attrs, 'regex_max_length');
  let regexMaxLength = ctx.regexMaxLength;
  if (localLimitAttr) {
    try {
      regexMaxLength = parseRegexMaxLength(attrMap['regex_max_length']);
    } catch (err) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(localLimitAttr),
        message: err instanceof Error ? err.message : String(err),
        hint: 'Use a positive integer, e.g. regex_max_length="64".',
        code: 'TDC096',
      });
      return;
    }
  }

  try {
    // Parse for its validating side-effect — throws on an invalid pattern.
    parseAdvancedRegexProgram(attrMap['value'] ?? '', { regexMaxLength });
  } catch (err) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(valueAttr),
      message: `invalid advanced_regex generator pattern: ${
        err instanceof Error ? err.message : String(err)
      }`,
      hint: 'Use finite advanced regex. Weighted choice syntax is (?%{70:A;30:B}); branch percentages must sum to 100.',
      code: 'TDC130',
    });
  }
}

/** Attribute lookup that preserves access to the AttrContext for positions. */
function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}
