/**
 * Validation for `<gen type="regex">`.
 */

import { attrValueRange, nodeRange, type Diagnostic } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { parseRegexMaxLength, parseRegexProgram } from '../generators/regex.js';
import { extractAttrs } from '../processor/walk.js';
import { isBlank } from './blank-value.js';

export interface RegexValidationContext {
  readonly diagnostics: Diagnostic[];
  readonly regexMaxLength: number;
}

export function checkGenRegex(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: RegexValidationContext,
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const valueAttr = findAttr(attrs, 'value');
  if (!valueAttr || isBlank(attrMap['value'])) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="regex"> requires a "value" attribute',
      hint: 'Provide a finite regex pattern, e.g. value="[A-Z]{2}[0-9]{6}".',
      code: 'TDC095',
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
    parseRegexProgram(attrMap['value'] ?? '', { regexMaxLength });
  } catch (err) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(valueAttr),
      message: `invalid regex generator pattern: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Use finite regex: bounded quantifiers such as {n} or {n,m}; unbounded *, +, and {n,} are rejected.',
      code: 'TDC097',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}
