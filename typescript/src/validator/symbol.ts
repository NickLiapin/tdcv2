/**
 * Validation for `<gen type="symbol">` attributes.
 */

import {
  type Diagnostic,
  attrValueRange,
  closestMatch,
  formatCandidates,
  nodeRange,
} from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { parseSymbolLength, resolveSymbolChars } from '../generators/symbol.js';
import { extractAttrs } from '../processor/walk.js';
import { ALPHABET_NAMES, resolveAlphabetChars } from '../unicode/alphabets.js';
import { CharSetError, parseCharSet } from '../unicode/charset.js';

export function checkGenSymbol(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const before = diagnostics.length;
  const alphabetAttr = findAttr(attrs, 'alphabet');
  const valueAttr = findAttr(attrs, 'value');
  const hasAlphabet = (attrMap['alphabet'] ?? '').length > 0;
  const hasValue = (attrMap['value'] ?? '').length > 0;

  if (hasAlphabet && hasValue) {
    const conflictAttr = valueAttr ?? alphabetAttr;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(conflictAttr ? attrValueRange(conflictAttr) : nodeRange(gen)),
      message: '<gen type="symbol"> accepts either "value" or "alphabet", not both',
      hint: 'Use `value="[a-z]"` for an inline set, or `alphabet="cyrillic.ru.letters"` for a named one.',
      code: 'TDC098',
    });
  } else if (!hasAlphabet && !hasValue) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="symbol"> requires a "value" (inline set) or "alphabet" (named)',
      hint: `Inline: value="[a-z]" or value="कखगघ". Named, e.g. alphabet="cyrillic.ru.letters". Known: ${formatCandidates(
        ALPHABET_NAMES,
        8,
      )}.`,
      code: 'TDC098',
    });
  } else if (hasAlphabet) {
    const alphabet = attrMap['alphabet'] ?? '';
    if (resolveAlphabetChars(alphabet) === undefined) {
      const suggestion = closestMatch(alphabet, ALPHABET_NAMES);
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...(alphabetAttr ? attrValueRange(alphabetAttr) : nodeRange(gen)),
        message: `unknown alphabet "${alphabet}"`,
        ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
        hint: `Known alphabets: ${formatCandidates(ALPHABET_NAMES)}.`,
        code: 'TDC099',
      });
    }
  } else if (hasValue && valueAttr) {
    // Inline set: must parse and be non-empty.
    const raw = attrMap['value'] ?? '';
    try {
      const set = parseCharSet(raw);
      if (set.length === 0) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...attrValueRange(valueAttr),
          message: `symbol value "${raw}" produces an empty character set`,
          hint: 'Provide at least one character, e.g. value="abc" or value="[a-z]".',
          code: 'TDC099',
        });
      }
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(valueAttr),
        message: err instanceof CharSetError ? err.message : String(err),
        hint: 'Ranges look like "[a-z]"; literals are written directly, e.g. "abcd".',
        code: 'TDC099',
      });
    }
  }

  // include / exclude modifiers — same char-set grammar as `value`.
  checkModifier(findAttr(attrs, 'include'), attrMap['include'], 'include', diagnostics);
  checkModifier(findAttr(attrs, 'exclude'), attrMap['exclude'], 'exclude', diagnostics);

  // Final-set emptiness (e.g. value="ab" exclude="ab"). Only when nothing
  // above flagged an error for THIS gen, so we don't double-report.
  if (diagnostics.length === before && (hasAlphabet || hasValue)) {
    try {
      resolveSymbolChars({
        value: attrMap['value'],
        alphabet: attrMap['alphabet'],
        include: attrMap['include'],
        exclude: attrMap['exclude'],
      });
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(gen),
        message: err instanceof Error ? err.message : String(err),
        hint: 'Make sure include/exclude do not remove every character.',
        code: 'TDC099',
      });
    }
  }

  const lengthAttr = findAttr(attrs, 'length');
  if (!lengthAttr) return;

  try {
    parseSymbolLength(attrMap['length']);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(lengthAttr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'Use a positive integer length, e.g. length="8".',
      code: 'TDC099',
    });
  }
}

/** Validate an include/exclude modifier parses as a character set. */
function checkModifier(
  attr: AttrContext | undefined,
  raw: string | undefined,
  label: string,
  diagnostics: Diagnostic[],
): void {
  if (attr === undefined || raw === undefined || raw.length === 0) return;
  try {
    parseCharSet(raw);
  } catch (err) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `symbol ${label}: ${err instanceof CharSetError ? err.message : String(err)}`,
      hint: 'Ranges look like "[a-z]"; literals are written directly, e.g. "xyz".',
      code: 'TDC099',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}
