/**
 * A distribution parameter written as an EXPRESSION rather than a number.
 *
 * `lambda="Traffic * 0.5"` is an intensity driven by another column;
 * `sd="0.5 + 0.01 * _count"` is a sensor that grows noisier as the run goes on.
 * A bare number stays the ordinary case and costs nothing — the spec is parsed
 * once, exactly as before, and only a config that names a column comes here.
 *
 * Why this is allowed at all, when a per-row `repeat=` is not: how many uniform
 * draws a row consumes depends on WHICH distribution, never on its parameters.
 * The parameter changes the value the draws are turned into, not their number,
 * so the row stays computable without its predecessors — the property every
 * engine is built on. See `sequence/repeat.ts` for the case where that argument
 * fails and the answer had to be a whole-run quota instead.
 */

import {
  distributionDraws,
  expressionParams,
  formatSample,
  parseDistribution,
  sampleDistribution,
} from '../generators/distribution.js';
import { openUnit } from '../prng/seekable.js';
import { evaluateValueInScope } from '../expr/index.js';
import { absoluteRow } from './per-row.js';
import { FormulaError, NUMERIC } from './formula.js';
import type { AttrMap } from '../processor/attrs.js';

import type { SequenceBuildContext } from './context.js';

/**
 * The generator's attributes with every expression-valued parameter replaced by
 * its answer on row `i`.
 *
 * Reads through `ctx.valueAt`, which BOTH engines already fill — the in-memory
 * one from its registry, the streaming one from its lazy registry — so this
 * needed no new seam. The expression language is the same one `if=` and
 * `formula` use, so a parameter and a condition cannot come to mean different
 * things by the same words.
 *
 * A parameter that does not resolve to a number is left as the text it was, and
 * `parseDistribution` refuses it with the message it already has — which names
 * the parameter and the distribution, and is better than anything invented here.
 */
export function resolveParams(
  attrs: AttrMap,
  dynamic: readonly string[],
  ctx: SequenceBuildContext,
  row: number,
): ResolvedParams {
  const out: Record<string, string> = { ...attrs };
  // What the lookups saw, in the shape `formula` uses: `empty` for a column that
  // held nothing, `text` for the first that held words rather than a number.
  // An object rather than two locals because they are written inside a callback,
  // and the reader below must see what the callback wrote.
  const read: { empty: boolean; text?: { name: string; value: string } } = { empty: false };
  for (const name of dynamic) {
    const expr = attrs[name];
    if (expr === undefined) continue;
    const value = evaluateValueInScope(expr, (ref) => {
      if (ref === '_count') return String(row + 1);
      const cell = ctx.valueAt?.(ref, row);
      if (ctx.hasColumn?.(ref) === true) {
        // A name the registry knows, holding nothing: the row a `parent=` filter
        // switched off, or a `missing=` blank. That is not a zero, and it cannot
        // be told apart later — an unresolved bare word evaluates to the WORD,
        // the way `if="Tier == hi"` reads `hi`. So it is noticed at the lookup.
        if ((cell ?? '').trim() === '') read.empty = true;
        else if (read.text === undefined && !NUMERIC.test(cell ?? ''))
          read.text = { name: ref, value: cell ?? '' };
      }
      return cell;
    });
    if (typeof value === 'bigint') out[name] = value.toString();
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value);
    // A bare column reference resolves to the cell's TEXT — `mean="M"` where M
    // holds "100". Arithmetic would have produced a number, but naming a column
    // and nothing else is the simplest way to write this and must work too.
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
      out[name] = value.trim();
    // Nothing numeric came out, and a column is the reason. Say which — the
    // distribution's own message would only repeat that the parameter is "not a
    // number", which the author can already see. Same wording as the formula
    // generator, because it is the same mistake read from the same columns.
    else if (!read.empty && read.text !== undefined) {
      throw new FormulaError(
        `${name}: the expression is not a number: column "${read.text.name}" holds ` +
          `"${read.text.value}", which is text rather than a number`,
      );
    }
  }
  return { attrs: out, empty: read.empty };
}

/** A resolved parameter set, and whether any of it read an empty cell. */
export interface ResolvedParams {
  readonly attrs: AttrMap;
  /** A referenced column was empty on this row, so nothing can be drawn. */
  readonly empty: boolean;
}

/**
 * One `<gen type="number" distribution="…">` column.
 *
 * Lifted out of the main builder whole, because the parameter resolution above
 * belongs beside it and the two together were what pushed `build.ts` past the
 * repo's ceiling on file length.
 */
export function distributionColumn(
  attrs: AttrMap,
  count: number,
  prng: () => number,
  ctx: SequenceBuildContext,
): string[] {
  const dynamic = expressionParams(attrs);
  const fixed = dynamic.length === 0 ? parseDistribution(attrs) : undefined;
  const out = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    const resolved =
      fixed === undefined ? resolveParams(attrs, dynamic, ctx, absoluteRow(ctx, i)) : undefined;
    // Nothing to draw from, so nothing is drawn: the row comes out empty, which
    // is what `<gen type="formula">` does with the same input. One rule for "the
    // source said nothing", wherever the source is read.
    if (resolved?.empty === true) {
      // The uniforms are spent anyway. Otherwise blanking one cell would slide
      // every value after it, and a `parent=` filter would quietly rewrite the
      // rest of the column.
      for (let d = 0; d < distributionDraws(attrs); d++) prng();
      out[i] = '';
      continue;
    }
    const spec = fixed ?? parseDistribution(resolved?.attrs ?? attrs);
    const uniforms = new Array<number>(spec.draws);
    for (let d = 0; d < spec.draws; d++) uniforms[d] = openUnit(prng());
    out[i] = formatSample(sampleDistribution(spec, uniforms), spec);
  }
  return out;
}
