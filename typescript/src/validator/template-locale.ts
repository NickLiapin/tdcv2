/**
 * A template path that exists — but not for the locale this run will use.
 *
 * `check` used to pass such a config and the run then refused it with
 * "unknown template path", which reads as a typo and is not one: the path is
 * known, the DATA for this locale is missing. Caught here, before a single row
 * is generated, naming the locales that do ship it.
 *
 * Extracted from validate.ts to keep that file under the 1000-line ceiling;
 * it depends on nothing in it.
 */

import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';

import { extractAttrs } from '../processor/walk.js';
import { nodeRange } from '../errors/source-map.js';
import { closestMatch } from '../errors/suggestions.js';
import { isBlank } from './blank-value.js';
import {
  KNOWN_TEMPLATE_PATHS,
  candidateTemplatePaths,
  isDynamicTemplateValue,
  siblingTemplatePaths,
  templatePathKnown,
} from './known.js';
import { checkBirthDateTemplate, checkDateRangeTemplate } from './date.js';
import { checkTemplateParams, type PackParamWidths, type PackParams } from './pack-params.js';

import type { Diagnostic } from '../errors/diagnostic.js';
import { BUILTIN_TEMPLATE_PATHS, localesHavingPath } from './known.js';
import { attrValueRange } from '../errors/source-map.js';
import { formatCandidates } from '../errors/suggestions.js';

/** The attribute node named `name`, for a diagnostic that points at its value. */
function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}

/** What these checks need from the validator's context. */
export interface TemplateLocaleCtx {
  readonly diagnostics: Diagnostic[];
  readonly packAddresses: readonly string[];
  readonly locale: string;
  readonly packParams: PackParams | undefined;
  readonly packParamWidths: PackParamWidths | undefined;
}

/**
 * A template path that exists — but not for the locale this run will use.
 *
 * `check` used to pass such a config and the run then refused it with
 * "unknown template path", which reads as a typo and is not one: the path is
 * known, the DATA for this locale is missing. Caught here, before a single row
 * is generated, naming the locales that do ship it.
 *
 * Silent when the caller loaded no packs (isolated validator tests), when the
 * address is absolute (`fr.person.lastName`, `russia.tax.inn_org`), and for
 * builtin generator paths — none of those depend on the env locale.
 */
export function checkTemplateLocale(
  path: string,
  attrMap: Record<string, string>,
  valueAttr: AttrContext,
  ctx: TemplateLocaleCtx,
): void {
  if (ctx.packAddresses.length === 0) return;
  if (BUILTIN_TEMPLATE_PATHS.includes(path)) return;
  // An absolute address carries its own locale or country; nothing to resolve.
  if (ctx.packAddresses.includes(path)) return;

  const locale = (attrMap['local'] ?? '').trim() || ctx.locale;
  const havers = localesHavingPath(path, ctx.packAddresses);
  if (havers.length === 0) return; // not a soft path at all — TDC071 covered it
  if (havers.includes(locale)) return;

  ctx.diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(valueAttr),
    message: `template path "${path}" has no data for locale "${locale}"`,
    hint:
      `It exists in: ${formatCandidates(havers)}. Set local="…" on this <gen> or on ` +
      '<env>, or choose a path your locale ships.',
    code: 'TDC217',
  });
}

export function checkGenTemplate(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: TemplateLocaleCtx,
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const valueAttr = findAttr(attrs, 'value');
  // A blank address is no address. TDC071 would call the empty string an unknown
  // path and offer to check its spelling, which is a hint about text nobody wrote.
  if (!valueAttr || isBlank(attrMap['value'])) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="template"> requires a "value" attribute',
      hint: `Use a known template path, e.g. ${formatCandidates(KNOWN_TEMPLATE_PATHS, 3)}.`,
      code: 'TDC070',
    });
    return;
  }
  const path = attrMap['value'] ?? '';
  // A `${{Field}}`-interpolated address resolves per row at render time; there is
  // no static path to check here (the field it names is validated as a sequence
  // reference elsewhere).
  if (isDynamicTemplateValue(path)) return;
  // Valid if a builtin, a hard pack address, or a soft shape (some locale has
  // it). The concrete locale is resolved against the env at render time.
  if (!templatePathKnown(path, ctx.packAddresses)) {
    // Suggest against what is actually loaded, not against the nine canonical
    // shapes: a country pack names its own subdivisions, so the leaf a reader
    // guesses (`province`) is often `state`, `region` or `department` here.
    const siblings = siblingTemplatePaths(path, ctx.packAddresses);
    // Search the namespace first when it exists. Across the whole pack list the
    // nearest string to `usa.geo.province` is `cuba.geo.province` — a real path,
    // in the wrong country, and worse than no suggestion at all.
    const suggestion =
      siblings.length > 0
        ? closestMatch(path, siblings)
        : closestMatch(path, candidateTemplatePaths(ctx.packAddresses));
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(valueAttr),
      message: `unknown template path "${path}"`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint:
        siblings.length > 0
          ? `Beside it: ${formatCandidates(siblings)}.`
          : `Known paths: ${formatCandidates(KNOWN_TEMPLATE_PATHS)}.`,
      code: 'TDC071',
    });
    return;
  }
  checkTemplateLocale(path, attrMap, valueAttr, ctx);

  checkTemplateParams(gen.attr(), attrMap, path, ctx, ctx.diagnostics);

  if (path === 'person.b_day') {
    checkBirthDateTemplate(gen, ctx.diagnostics);
  }

  // date.range requires a `range` attribute in the right format.
  if (path === 'date.range') {
    checkDateRangeTemplate(gen, ctx.diagnostics);
  }
}
