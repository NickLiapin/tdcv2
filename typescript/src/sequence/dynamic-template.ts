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
 * per applicable row, in mask order (what `assembleValues` consumes).
 */
export function buildDynamicTemplateValues(
  gen: GenSpec,
  mask: readonly boolean[],
  registry: SequenceRegistry,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): string[] {
  const template = gen.attrs['value'] ?? '';
  const localeAttr = gen.attrs['local'] ?? locale;
  const out: string[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const address = interpolate(template, '${{%}}', i, registry);
    const packEntry = ctx.packs?.get(resolvePackAddress(address, localeAttr));
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
      out.push(textUniform(packEntry.values)(1, prng)[0] ?? '');
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
