/**
 * `parent="Name"` and `parent="Name.Value"` — what a child may be built over.
 *
 * A parent selects rows by the VALUE it produced: `parent="Gender.Male"` is
 * "the rows where Gender came out Male". Two things follow, and both used to be
 * found only when the run was already underway.
 *
 * The parent has to exist by the time the child is declared, because the rows it
 * selects are what the child is built over — and it has to have a value at all.
 * A compound sequence is a group of fields and produces none, so no row could
 * ever match it; the engine discovered that mid-generation and reported the
 * parent as "unknown", sending the reader to look for a name declared right
 * above.
 */

import { type Diagnostic, attrValueRange, closestMatch } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

import { BUILTIN_SEQUENCES } from './known.js';

export interface ParentRefContext {
  readonly diagnostics: Diagnostic[];
  /** Every name declared so far, in declaration order. */
  readonly declared: readonly string[];
  /** Of those, the compounds — the ones with no value of their own. */
  readonly valueless: readonly string[];
  /** What each sequence produces, where the config says outright. */
  readonly finiteValues?: ReadonlyMap<string, readonly string[]>;
}

export function checkParentRef(
  el: OpenCloseElementContext | SelfClosingElementContext,
  ctx: ParentRefContext,
): void {
  const attrs = el.attr();
  const parentAttr = findAttr(attrs, 'parent');
  if (!parentAttr) return;

  const raw = extractAttrs(attrs)['parent'] ?? '';
  const dotIdx = raw.indexOf('.');
  const parentName = dotIdx < 0 ? raw : raw.slice(0, dotIdx);
  const known = [...ctx.declared, ...BUILTIN_SEQUENCES];

  if (parentName.length === 0) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(parentAttr),
      message: `invalid parent reference "${raw}"`,
      hint: 'Syntax: parent="ParentName" or parent="ParentName.Value".',
      code: 'TDC034',
    });
    return;
  }

  if (!known.includes(parentName)) {
    const suggestion = closestMatch(parentName, known);
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(parentAttr),
      message: `parent sequence "${parentName}" is not declared before this sequence`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint: 'Parent sequences must be declared earlier in the same <env>. Forward references and cycles are not supported.',
      code: 'TDC035',
    });
    return;
  }

  // `parent="Gender.Male"` where Gender produces M and F. The child is then
  // active on ZERO rows, and until now nothing said so — `check` called the
  // config valid and the two engines disagreed about what to do next: the
  // streaming builder refused ("stream mode: … which the parent never
  // produces"), the in-memory engine handed back a column of blanks. One config,
  // two answers, depending on a routing decision the user never made.
  //
  // The same question `if="Gender.Male"` has warned about for a while, and the
  // documentation says the two readings are the same. Warned here with the same
  // code and the same words.
  const wanted = dotIdx < 0 ? '' : raw.slice(dotIdx + 1);
  const parentValues = ctx.finiteValues?.get(parentName);
  if (wanted !== '' && parentValues && !parentValues.includes(wanted)) {
    const suggestion = closestMatch(wanted, [...parentValues]);
    ctx.diagnostics.push({
      severity: 'warning',
      source: 'validator',
      ...attrValueRange(parentAttr),
      message: `"${parentName}" never produces "${wanted}", so this sequence is drawn on no row`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint: `"${parentName}" produces: ${[...parentValues].join(', ')}.`,
      code: 'TDC216',
    });
  }

  if (ctx.valueless.includes(parentName)) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(parentAttr),
      message: `compound sequence "${parentName}" has no value of its own to filter on`,
      hint: `A parent is chosen by the value it produced, e.g. parent="Gender.Male". "${parentName}" is a group of fields and produces none — name one of its fields, or a sequence that has a single value.`,
      code: 'TDC214',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}
