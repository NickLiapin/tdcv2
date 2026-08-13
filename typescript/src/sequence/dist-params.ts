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
  expressionParams,
  formatSample,
  parseDistribution,
  sampleDistribution,
} from '../generators/distribution.js';
import { openUnit } from '../prng/seekable.js';
import { evaluateValueInScope } from '../expr/index.js';
import { absoluteRow } from './per-row.js';
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
): AttrMap {
  const out: Record<string, string> = { ...attrs };
  for (const name of dynamic) {
    const expr = attrs[name];
    if (expr === undefined) continue;
    const value = evaluateValueInScope(expr, (ref) => {
      if (ref === '_count') return String(row + 1);
      return ctx.valueAt?.(ref, row);
    });
    if (typeof value === 'bigint') out[name] = value.toString();
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value);
    // A bare column reference resolves to the cell's TEXT — `mean="M"` where M
    // holds "100". Arithmetic would have produced a number, but naming a column
    // and nothing else is the simplest way to write this and must work too.
    else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
      out[name] = value.trim();
  }
  return out;
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
    const spec =
      fixed ?? parseDistribution(resolveParams(attrs, dynamic, ctx, absoluteRow(ctx, i)));
    const uniforms = new Array<number>(spec.draws);
    for (let d = 0; d < spec.draws; d++) uniforms[d] = openUnit(prng());
    out[i] = formatSample(sampleDistribution(spec, uniforms), spec);
  }
  return out;
}
