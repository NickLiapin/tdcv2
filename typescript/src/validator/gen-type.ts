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
import { callsPrev, checkGenFormula } from './formula.js';
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
 * Where a `<gen>` stands, as far as the placement rules below care.
 *
 *   sequence  the whole `<sequence>`: one unnamed `<gen>`, nothing beside it
 *   branch    one of a sequence's `<gen if="…">` branches, or the fallback after them
 *   case      inside a `<case>` or `<default>`, at any depth
 *   part      an unnamed part of a composed `<sequence>` — beside a literal or another part
 *   field     a named field of a compound `<sequence>`
 */
export type GenPlace = 'sequence' | 'branch' | 'case' | 'part' | 'field';

/**
 * A derived column in a place it cannot mean anything.
 *
 * The four derived constructs differ in how much of the run they read (see
 * `sequence/derived.ts`), and that decides where each may stand:
 *
 *   - `running`, `stat`, and a `formula` that reads `prev()` are WHOLE columns —
 *     the rows before this one, or all of them. A branch holds some rows and not
 *     others, so they must be a `<sequence>` of their own.
 *   - a plain `formula` and a date offset read only their own row, so a branch —
 *     a `<case>`, or an `if=` branch — can have them: each row the branch holds is
 *     computed from that row.
 *   - none of the four is a part or a field of a record. A record's parts are
 *     drawn together and rearranged together by `<distinct>` and `uniq`, and a
 *     computed value moved to another row no longer describes it.
 *
 * Measured before this rule reached past `if=`, on all five implementations: in a
 * `<case>`, a part, a field or the fallback branch, `check` called every one of
 * these valid; the run then stopped with `gen type "running" not yet supported`,
 * or — a date offset — silently dropped `of=` and drew an unrelated date.
 */
function checkDerivedPlace(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  type: string | undefined,
  place: GenPlace,
  diagnostics: Diagnostic[],
): void {
  if (place === 'sequence') return;
  const attrs = extractAttrs(gen.attr());
  if (!isDerived(type, attrs)) return;
  const wholeRun =
    type === 'running' || type === 'stat' || (type === 'formula' && callsPrev(attrs['expr'] ?? ''));
  const inRecord = place === 'part' || place === 'field';
  if (!wholeRun && !inRecord) return;

  const ifAttr = gen.attr().find((a) => a._attrName?.text === 'if');
  const typeAttr = gen.attr().find((a) => a._attrName?.text === 'type');
  const at = place === 'branch' && ifAttr ? ifAttr : typeAttr;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...(at ? attrValueRange(at) : nodeRange(gen)),
    message: derivedPlaceMessage(type, wholeRun, place, ifAttr !== undefined),
    hint: wholeRun
      ? place === 'branch' && ifAttr
        ? 'It reads other columns in declaration order and produces one column, not a value ' +
          'chosen per row. Put the condition where the value is USED — `<data if="…">` — or ' +
          'compute the column unconditionally and branch on it afterwards.'
        : 'It reads other columns in declaration order and produces one column. Declare it as a ' +
          '<sequence> of its own, above this one, and use it here by name — ${{Total}} in a ' +
          '<data>, or Total inside a formula.'
      : 'Declare it as a <sequence> of its own and put it into the record where the record is ' +
        'printed: <data>ID-${{Total}}</data>.',
    code: 'TDC295',
  });
}

/** The TDC295 sentence: what the column is, and why it cannot stand where it does. */
function derivedPlaceMessage(
  type: string | undefined,
  wholeRun: boolean,
  place: GenPlace,
  carriesIf: boolean,
): string {
  const what =
    type === 'date'
      ? 'a date measured from another column (of=)'
      : type === 'formula' && wholeRun
        ? 'a type="formula" column that reads prev()'
        : `a type="${String(type)}" column`;
  const where =
    place === 'branch'
      ? carriesIf
        ? 'carry if='
        : 'be the fallback branch of a conditional sequence'
      : place === 'case'
        ? 'sit inside a <case>'
        : place === 'part'
          ? 'be one part of a composed <sequence>'
          : 'be a field of a compound <sequence>';
  return wholeRun
    ? `${what} is built for the whole run, so it cannot ${where}`
    : `${what} is computed from other columns, so it cannot ${where}`;
}

export function checkGenByType(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  type: string | undefined,
  ctx: GenTypeCtx,
  place: GenPlace = 'sequence',
): void {
  checkDerivedPlace(gen, type, place, ctx.diagnostics);
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
