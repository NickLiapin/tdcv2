/**
 * Per-type generator validation, dispatched by `type=`.
 *
 * Lifted out of `validate.ts` when it hit the repo's own ceiling on file
 * length. Every branch here calls a checker that already lives in its own file,
 * so the move introduced no logic and no cycle: the `ctx` each one takes is a
 * structural interface, not the validator's `Ctx` class.
 *
 * The type-INDEPENDENT checks stay behind in `checkGen`, which is the boundary
 * worth keeping — what every generator must satisfy, and what this one must.
 */

import type { Diagnostic } from '../errors/index.js';
import { attrValueRange, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';

import { checkGenAdvancedRegex, type AdvancedRegexValidationContext } from './advanced-regex.js';
import { checkGenCounter } from './counter.js';
import { checkGenDate } from './date.js';
import { checkGenDrawing, checkGenFile, type FileValidationContext } from './file.js';
import { checkGenFormula } from './formula.js';
import { checkGenHttp, type HttpCheckContext } from './http.js';
import { checkGenNumber } from './number.js';
import { checkGenRegex, type RegexValidationContext } from './regex.js';
import { checkGenRunning } from './running.js';
import { checkGenStat } from './stat.js';
import { checkGenSymbol } from './symbol.js';
import { checkGenTemplate, type TemplateLocaleCtx } from './template-locale.js';
import { checkGenText } from './text.js';
import { checkGenTimeseries } from './timeseries.js';

/**
 * What a per-type checker may reach for.
 *
 * The intersection of every context the branches below need, rather than the
 * validator's `Ctx` class — importing that would create the cycle
 * `data-element.ts` already documents avoiding.
 */
export type GenTypeCtx = FileValidationContext &
  TemplateLocaleCtx &
  RegexValidationContext &
  AdvancedRegexValidationContext &
  HttpCheckContext & {
    readonly diagnostics: Diagnostic[];
    readonly declaredSequences: readonly string[];
    /** The sequence this gen belongs to, for `prev()` naming its own column. */
    readonly currentSequence?: string | undefined;
    /** Of those, the ones whose `<gen>` repeats — a LIST in one cell. */
    readonly repeatingSequences: readonly string[];
    readonly locale: string;
  };

/**
 * The four types that are a WHOLE COLUMN read from other columns.
 *
 * Kept here beside the dispatch because the rule below is about all of them at
 * once — see `sequence/derived.ts` for what they are and what each one costs.
 */
const DERIVED_TYPES: ReadonlySet<string> = new Set(['running', 'stat', 'formula']);

/** Is this `<gen>` a whole column read from other columns? */
export function isDerived(type: string | undefined, attrs: Record<string, string>): boolean {
  if (type === undefined) return false;
  if (DERIVED_TYPES.has(type)) return true;
  return type === 'date' && (attrs['of'] ?? '').trim() !== '';
}

/**
 * A derived column cannot be ONE BRANCH of a per-row choice.
 *
 * `running`, `stat`, a date offset and `formula` are built once, for the whole
 * column, in declaration order. An `if=` asks for something else entirely: a
 * value chosen row by row. The two cannot both be true, and until now nothing
 * said so — `check` called the config valid and the run died with
 * `sequence: gen type "running" not yet supported`, which reads like an
 * unfinished engine rather than a config that cannot mean anything.
 *
 * Measured on 0.2.1: `<gen if="A > 0" type="running" …>` and the same with
 * `stat` and with a date offset all produced that message. Two of those three
 * are SHIPPED features; `formula` arrived with the same hole and is fixed here
 * with them.
 */
function checkDerivedNotConditional(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  type: string | undefined,
  diagnostics: Diagnostic[],
): void {
  const attrs = extractAttrs(gen.attr());
  if (!isDerived(type, attrs)) return;
  if ((attrs['if'] ?? '').trim() === '') return;
  const attr = gen.attr().find((a) => a._attrName?.text === 'if');
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...(attr ? attrValueRange(attr) : nodeRange(gen)),
    message: `a type="${String(type)}" column is built for the whole run, so it cannot carry if=`,
    hint:
      'It reads other columns in declaration order and produces one column, not a value ' +
      'chosen per row. Put the condition where the value is USED — `<data if="…">` — or ' +
      'compute the column unconditionally and branch on it afterwards.',
    code: 'TDC295',
  });
}

export function checkGenByType(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  type: string | undefined,
  ctx: GenTypeCtx,
): void {
  checkDerivedNotConditional(gen, type, ctx.diagnostics);
  switch (type) {
    case 'text':
      checkGenText(gen, ctx.diagnostics);
      break;
    case 'file':
      checkGenFile(gen, ctx);
      break;
    case 'pattern':
      checkGenDrawing(gen, ctx);
      break;
    case 'template':
      checkGenTemplate(gen, ctx);
      break;
    case 'number':
      checkGenNumber(gen, ctx.diagnostics, ctx.declaredSequences);
      break;
    case 'regex':
      checkGenRegex(gen, ctx);
      break;
    case 'advanced_regex':
      checkGenAdvancedRegex(gen, ctx);
      break;
    case 'symbol':
      checkGenSymbol(gen, ctx.diagnostics);
      break;
    case 'date':
      checkGenDate(gen, ctx.declaredSequences, ctx.diagnostics, ctx.locale, ctx.repeatingSequences);
      break;
    case 'timeseries':
      checkGenTimeseries(gen, ctx.diagnostics);
      break;
    case 'increment':
    case 'decrement':
      checkGenCounter(gen, ctx.diagnostics);
      break;
    case 'http':
      checkGenHttp(gen, ctx);
      break;
    case 'running':
      checkGenRunning(gen, ctx.declaredSequences, ctx.diagnostics);
      break;
    case 'stat':
      checkGenStat(gen, ctx.declaredSequences, ctx.diagnostics);
      break;
    case 'formula':
      checkGenFormula(gen, ctx.declaredSequences, ctx.diagnostics, ctx.currentSequence);
      break;
  }
}
