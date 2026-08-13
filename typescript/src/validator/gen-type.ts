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
    readonly locale: string;
  };

export function checkGenByType(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  type: string | undefined,
  ctx: GenTypeCtx,
): void {
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
      checkGenNumber(gen, ctx.diagnostics);
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
      checkGenDate(gen, ctx.declaredSequences, ctx.diagnostics, ctx.locale);
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
      checkGenFormula(gen, ctx.declaredSequences, ctx.diagnostics);
      break;
  }
}
