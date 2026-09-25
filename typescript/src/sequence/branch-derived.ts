/**
 * A formula or a date offset standing in a BRANCH — inside a `<case>`, or as one
 * of the `<gen if="…">` branches of a sequence — rather than as a whole column.
 *
 * Of the four derived constructs, these two read nothing but their own row (see
 * `derived.ts` for the cost model). So a branch can have them as cheaply as a
 * whole column can: for each row the branch holds, compute that row. Measured
 * before this file existed, on all five implementations: a date offset in a
 * branch lost `of=` and `plus=` without a word and drew an unrelated date, and a
 * formula passed `check` and then stopped the run with `gen type "formula" not
 * yet supported` — in four of them; the fifth computed it on one engine only.
 *
 * `running`, `stat`, a formula that reads `prev()` and a pool reference are whole
 * columns by nature, and the validator keeps them out of branches (TDC295,
 * TDC268). They never reach this file.
 */

import { applyOffset, parseOffset, toEpochMillis } from '../date/calendar.js';
import { formatDateTime } from '../date/index.js';
import { evaluateValueInScope } from '../expr/index.js';
import { seekableGen } from '../prng/seekable.js';

import type { SequenceBuildContext } from './context.js';
import { drawSteps, startOfRow } from './date-offset.js';
import { columnScope, formulaDecimals, renderFormulaValue } from './formula.js';
import type { ColumnsRead } from './formula.js';
import { absoluteRow } from './per-row.js';
import type { CasePart, GenSpec, SequenceSpec } from './types.js';

/** A formula, or a date measured from another column: the two that read only their row. */
export function isRowLocalDerived(gen: GenSpec): boolean {
  return gen.type === 'formula' || (gen.type === 'date' && (gen.attrs['of'] ?? '').trim() !== '');
}

/**
 * `prev()` inside a branch. The validator refuses it (TDC295) — a formula that reads
 * the row before is built in row order over the whole run — so this is the backstop
 * for a caller that skipped validation, and it says the same thing.
 */
const PREV_IN_BRANCH = (): string | undefined => {
  throw new Error(
    'prev() reads the row before this one, so a formula using it has to be a <sequence> of ' +
      'its own — it cannot sit inside a <case> or be one branch of an if= sequence',
  );
};

/**
 * The branch's values, one per position of the build — or `''` for a row the
 * build will not keep (see `keptRows` on the context).
 */
export function rowLocalDerivedValues(
  gen: GenSpec,
  count: number,
  prng: () => number,
  locale: string,
  ctx: SequenceBuildContext,
  instantsOut?: (number | undefined)[],
): string[] {
  return gen.type === 'formula'
    ? branchFormula(gen, count, ctx)
    : branchDateOffset(gen, count, prng, locale, ctx, instantsOut);
}

function branchFormula(gen: GenSpec, count: number, ctx: SequenceBuildContext): string[] {
  const expr = (gen.attrs['expr'] ?? '').trim();
  const out = new Array<string>(count).fill('');
  if (expr === '') return out; // no expr= — the validator reports it
  const decimals = formulaDecimals(gen.attrs);
  for (let i = 0; i < count; i++) {
    const row = absoluteRow(ctx, i);
    if (ctx.keptRows && !ctx.keptRows.has(row)) continue;
    const read: ColumnsRead = {};
    const scope = columnScope(
      row,
      (name) => ctx.hasColumn?.(name) === true,
      (name) => ctx.valueAt?.(name, row),
      read,
    );
    const answer = evaluateValueInScope(expr, scope, PREV_IN_BRANCH);
    // A column this row does not have leaves the cell empty, as it does for a
    // formula that is a whole column: a zero nobody generated is not an answer.
    out[i] = read.empty === true ? '' : renderFormulaValue(answer, decimals, read);
  }
  return out;
}

/**
 * The same measurement `registerDateOffset` makes, row by row.
 *
 * A ranged `plus=` draws its step from the row's own stream — `(seed, stream,
 * row)` — so the step a row gets does not depend on which other rows the branch
 * holds. A fixed one draws nothing, as it does everywhere.
 */
function branchDateOffset(
  gen: GenSpec,
  count: number,
  prng: () => number,
  locale: string,
  ctx: SequenceBuildContext,
  instantsOut?: (number | undefined)[],
): string[] {
  const out = new Array<string>(count).fill('');
  const of = (gen.attrs['of'] ?? '').trim();
  const parsed = parseOffset(gen.attrs['plus']);
  // An unknown column or a bad plus= is a diagnostic, not a crash.
  if (ctx.hasColumn?.(of) !== true || !parsed.ok) return out;
  const offset = parsed.offset;
  const format = (gen.attrs['format'] ?? '').trim() || 'L';
  const instantAt = ctx.instantsOf?.(of);
  const column = (ctx.streamId ?? '').split('#')[0] ?? '';
  for (let i = 0; i < count; i++) {
    const row = absoluteRow(ctx, i);
    if (ctx.keptRows && !ctx.keptRows.has(row)) continue;
    const from = ctx.valueAt?.(of, row);
    if (from === undefined || from.trim() === '') continue;
    const start = startOfRow(column, of, instantAt, row, from);
    if (!start) continue;
    const draw =
      ctx.seed !== undefined && ctx.streamId !== undefined
        ? seekableGen(ctx.seed, ctx.streamId, row)
        : prng;
    const landed = applyOffset(start, offset, drawSteps(offset, draw));
    if (instantsOut) instantsOut[i] = toEpochMillis(landed);
    out[i] = formatDateTime(landed, format, locale);
  }
  return out;
}

/** The context, keeping only `rows` of what it builds — narrowed, never widened. */
export function keepingOnly(
  ctx: SequenceBuildContext,
  rows: Iterable<number>,
): SequenceBuildContext {
  const kept = new Set<number>();
  for (const row of rows) if (!ctx.keptRows || ctx.keptRows.has(row)) kept.add(row);
  return { ...ctx, keptRows: kept };
}

/**
 * Every column some date offset measures from, wherever the offset stands — a
 * whole column, a `<case>` at any depth, an `if=` branch.
 *
 * Those columns keep the instant they generated beside the text, so the offset
 * works from the value whatever `format=` spelled it as.
 */
export function offsetSources(specs: readonly SequenceSpec[]): Set<string> {
  const sources = new Set<string>();
  const visit = (gen: GenSpec | undefined): void => {
    if (gen?.type === 'date') {
      const of = (gen.attrs['of'] ?? '').trim();
      if (of !== '') sources.add(of);
    }
  };
  const visitParts = (parts: readonly CasePart[]): void => {
    for (const part of parts) {
      if (part.kind === 'gen') visit(part.gen);
      else if (part.kind === 'mix') for (const c of part.mixSpec.cases) visitParts(c.parts);
      else if (part.kind === 'switch') {
        for (const e of part.switchSpec.entries) visitParts(e.value.parts);
        if (part.switchSpec.fallback) visitParts(part.switchSpec.fallback.parts);
      }
    }
  };
  for (const spec of specs) {
    visit(spec.gen);
    for (const branch of spec.conditional ?? []) visit(branch.gen);
    for (const c of spec.mixSpec?.cases ?? []) visitParts(c.parts);
    for (const e of spec.switchSpec?.entries ?? []) visitParts(e.value.parts);
    if (spec.switchSpec?.fallback) visitParts(spec.switchSpec.fallback.parts);
  }
  return sources;
}
