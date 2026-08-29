/**
 * A `<gen type="template">` whose `value` interpolates a sibling field —
 * `value="common.vehicle.model.${{Brand}}"`. The address is resolved PER ROW from the
 * registry, so the child pack is the one the parent named on that row (draw
 * "Fiat" → a Fiat model). TDC's coherent parent→child-by-name.
 *
 * In-memory engine only: the lazy (Engine 2) and on-disk (Engine 3) paths can't
 * resolve a per-row address, so a config that uses this is routed to Engine 1
 * (see `resolveRenderEngine`).
 */

import { resolvePackAddress } from '../data-pack/index.js';
import { textUniform } from '../generators/text.js';
import { interpolate } from '../processor/interpolate.js';
import { resolveTemplate } from '../templates/resolver.js';

import { paramOverrides, runGenerator } from './build.js';
import type { SequenceBuildContext } from './context.js';
import type { GenSpec, SequenceRegistry } from './types.js';

/**
 * Build the values for a dynamic-address template gen. For each applicable row
 * (in order) the address is interpolated from the registry, the pack is looked
 * up, and ONE value is drawn — a uniform pick, or the pack generator run once.
 * Deterministic: rows are walked in order, one PRNG draw each. Returns one value
 * per applicable row, in the order `rows` gives them (what `assembleAt` consumes).
 */
export function buildDynamicTemplateValues(
  gen: GenSpec,
  rows: readonly number[],
  registry: SequenceRegistry,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): string[] {
  const template = gen.attrs['value'] ?? '';
  const localeAttr = gen.attrs['local'] ?? locale;
  const out: string[] = [];
  for (const i of rows) {
    const address = interpolate(template, '${{%}}', i, registry);
    const packEntry = ctx.packs?.get(resolvePackAddress(address, localeAttr, ctx.packs));
    if (packEntry?.generator) {
      out.push(
        runGenerator(packEntry.generator, 1, prng, locale, now, {
          regexMaxLength: ctx.regexMaxLength,
          dataSources: ctx.dataSources,
          packs: ctx.packs,
          overrides: paramOverrides(gen.attrs),
        })[0] ?? '',
      );
      continue;
    }
    if (packEntry?.values) {
      // A WEIGHTED pack keeps its weights here. The address is not known until the row is, so
      // there is no column to lay an exact quota over — but the shares are still the shares,
      // and a per-row draw can honour them. Uniform dropped them: `person.${{Sex}}.firstName`
      // handed out `Mary` and `James` as often as the rarest name in the file, on 389 shipped
      // packs that declare `weighted: true`, while the same file read by a FIXED address was
      // exact to the row. The page promising this — coherent-data — says in as many words that
      // the makes "show up in realistic proportions".
      out.push(
        packEntry.percents === undefined
          ? (textUniform(packEntry.values)(1, prng)[0] ?? '')
          : weightedPick(prng, packEntry.values, packEntry.percents),
      );
      continue;
    }
    const source = resolveTemplate(address);
    if (!source) {
      throw new Error(
        `sequence: template value "${template}" resolved to unknown address "${address}"`,
      );
    }
    out.push(source(prng, gen.attrs, locale, now));
  }
  return out;
}

/**
 * One value from a weighted list, on ONE draw.
 *
 * A running subtraction rather than a cumulative table: the same arithmetic in the same order
 * in all five implementations, so one seed gives one row everywhere. Shares that sum to zero
 * (a pack whose counts are all zero) fall back to a uniform pick rather than to the last value.
 */
function weightedPick(
  prng: () => number,
  values: readonly string[],
  percents: readonly number[],
): string {
  let total = 0;
  for (const p of percents) total += p;
  if (!(total > 0)) return textUniform(values)(1, prng)[0] ?? '';
  let r = prng() * total;
  for (let i = 0; i < values.length; i++) {
    r -= percents[i] ?? 0;
    if (r < 0) return values[i] ?? '';
  }
  return values[values.length - 1] ?? '';
}
