/**
 * Sequence materialization.
 *
 * `buildSequences` consumes the ordered list of sequence specs declared
 * in the DSL `<env>` and produces a registry mapping each sequence name
 * to its materialized per-cell values. Parent-constrained sequences are
 * computed only over the subset of rows where the parent produced the
 * declared value; remaining rows get `undefined`. Percentages inside
 * child `<gen>` are evaluated over the constrained subset, not the
 * total `count` — this is the core of the "ierarchical probabilistic
 * dependencies" moat (docs/vision/02-sequences.md).
 *
 * The registry is also seeded with the built-in `_count` sequence
 * (1-based iteration index, one entry per row) for interpolation.
 *
 * Ordering: specs are processed in declaration order. A child sequence
 * whose `parent` references a later-declared sequence throws at the
 * dependency-lookup step — cycles and forward references are not
 * supported in this phase.
 */

import type { GeneratorBody } from '../data-pack/generator.js';
import { resolvePackAddress } from '../data-pack/index.js';
import type { PackRegistry } from '../data-pack/index.js';
import { interpolate } from '../processor/interpolate.js';
import { distributeByPercent } from '../distribution/hamilton.js';
import { expandPercentMask } from '../distribution/percent-mask.js';
import { resolveExistingDataSourcePath, type DataSourceOptions } from '../data-source/index.js';
import { advancedRegexGenerator } from '../generators/advanced-regex.js';
import { decrementGenerator, incrementGenerator } from '../generators/counter.js';
import { dateAxis, dateGenerator } from '../generators/date.js';
import { toEpochMillis } from '../date/index.js';
import { loadCsvColumnFile, loadListFile } from '../generators/file.js';

import { applyAnomaly, keepShape, parseAnomaly } from '../generators/anomaly.js';
import { applyMissing, parseMissing } from '../generators/missing.js';
import { numberGenerator } from '../generators/number.js';
import { patternGenDraws, patternGenValue } from '../generators/pattern.js';
import { regexGenerator } from '../generators/regex.js';
import { symbolGenerator } from '../generators/symbol.js';
import { textUniform } from '../generators/text.js';
import {
  formatTimeseries,
  parseTimeseries,
  standardNormal,
  timeseriesHasNoise,
  timeseriesValueAt,
} from '../generators/timeseries.js';
import { resolveTemplate } from '../templates/resolver.js';
import { isDynamicTemplateValue } from '../validator/known.js';
import { buildDynamicTemplateValues } from './dynamic-template.js';
import { StreamUnsupportedError } from './stream-build.js';
import { openUnit, seekableGen, seekableUniforms } from '../prng/seekable.js';
import {
  absoluteRow,
  exactTextLayout,
  forStreamOf,
  redrawCtx,
  INLINE_ANOMALY_TYPES,
  keyedDraws,
  listedValues,
  perRowBuildable,
  withRows,
} from './per-row.js';
export { patternGenForGen } from './pattern-source.js';
import { patternGenForGen } from './pattern-source.js';
import { evaluateIf } from '../expr/evaluate.js';

import { genFormatter } from '../format/transforms.js';
import type { AttrMap } from '../processor/attrs.js';

import type {
  CondBranch,
  GenSpec,
  Sequence,
  SequenceRegistry,
  SequenceSpec,
  MixSpec,
} from './types.js';
import { sequenceValueAt } from './types.js';
import { composesOwnValue, drawComposed, uniqDrawPart } from './composed.js';
import { buildMixValues } from './mix-values.js';
import { materializeCompute } from './compute-sequence.js';
import { materializeSwitch } from './switch-build.js';
import { assembleAt, computeParentMask, orderedRows } from './assemble.js';
import type { LinkedFileRowPlan, SequenceBuildContext } from './context.js';
import { buildUniqueValues } from './uniq-simple.js';
import { buildFileValues } from './file-values.js';
import { buildRepeatedValues, parseRepeat, type RepeatSpec } from './repeat.js';
import {
  buildKeyedRepeatDraws,
  buildKeyedRepeatLayout,
  keyedElementUniforms,
} from './repeat-keyed.js';
import { enforceUniqRedrawing } from './enforce-uniq.js';
import { enforceEnvDistinct, enforceEnvUniq } from './env-groups.js';
import { checkEnvUniqCapacity } from './uniq-capacity.js';
import { poolRefName, type PoolTables } from './pool.js';
import { registerPoolRef } from './pool-ref.js';
import { isDateOffset, offsetOf } from './date-offset.js';
import { registerDerivedColumn } from './derived.js';
import { distributionColumn } from './dist-params.js';
import { enforceValid } from './pack-valid.js';

/**
 * A uniq group's arrangement, as it travels: row index (as a string, so it
 * survives a structured clone) to the members' values for that row. Only the
 * rows that moved are in it, which is a few thousand out of a hundred million.
 */
export type UniqArrangement = Readonly<Record<string, readonly string[]>>;

/** Every env-level `<uniq>` group's arrangement, keyed by its members joined by ' × '. */
export type UniqPlan = Readonly<Record<string, UniqArrangement>>;

export interface SequenceBuildOptions {
  /**
   * Arrangements worked out elsewhere, so this build does not work them out
   * again.
   *
   * Deciding which rows move where is the expensive half of a uniq run — a
   * full pass over every row, twice — and it depends only on the config and the
   * seed. So it is worth doing once and telling everyone else. That is what
   * lets several threads each render a different range of rows of the same uniq
   * config: without it each thread would repeat the whole analysis, which is
   * slower than not splitting at all.
   */
  readonly uniqPlan?: UniqPlan | undefined;
  /** Called with each group's arrangement as it is worked out, so it can be passed on. */
  readonly onUniqPlan?: ((group: string, arrangement: UniqArrangement) => void) | undefined;
  /**
   * Build the members of an env-level `<uniq>` group but do NOT make them
   * unique.
   *
   * For the threads that compute the scan. Their whole job is to report what
   * each row drew BEFORE any rearrangement — that is the input the analysis
   * works on — so applying the analysis to get it would be circular.
   */
  readonly skipEnvUniq?: true;
  /** Colliding rows already found elsewhere, per uniq group. See `DuplicateScanOptions.knownExcess`. */
  readonly uniqExcess?: Readonly<Record<string, readonly number[]>> | undefined;
  /** Fingerprint piles for the hunt — Engine 5. See `DuplicateScanOptions.fingerprintBuckets`. */
  readonly uniqFingerprintBuckets?: number | undefined;
  /** Sorted fingerprint files computed elsewhere, per uniq group — the parallel coordinator's. */
  readonly uniqFingerprintFiles?: Readonly<Record<string, readonly string[]>> | undefined;
  /**
   * Called as the uniq machinery advances. The phases and shape are
   * `RenderProgress` — declared render-side because that is where the render
   * phase reports from; the uniq phases join through here.
   */
  readonly onProgress?:
    | ((progress: {
        phase: 'uniq-scan' | 'uniq-sort' | 'uniq-repair' | 'render';
        done: number;
        total: number;
      }) => void)
    | undefined;

  /**
   * Rows are computed strictly in order, so `prev()` has a previous row to read.
   *
   * Set from `<env mode="sequential">`. Not to be confused with
   * `order="sequential"` on a list-backed generator, which is about the order
   * values are DRAWN in and has nothing to do with this.
   */
  readonly sequential?: true;
  readonly regexMaxLength?: number | undefined;
  /**
   * A column's value at an absolute row, for a `<switch>` written inside a
   * `<case>`. The streaming engines fill it with a read of their own lazy
   * registry; the in-memory engine passes the same shape on its context.
   */
  readonly valueAt?: ((name: string, row: number) => string | undefined) | undefined;
  /** Is this name a column? See `SequenceBuildContext.hasColumn`. */
  readonly hasColumn?: ((name: string) => boolean) | undefined;
  /**
   * Pools already computed for this run, by name — see `pool-build.ts`. A
   * `<gen type="pool">` reads a member out of one of these instead of drawing a
   * value of its own.
   */
  readonly pools?: PoolTables | undefined;
  /**
   * The run's seed, needed only to pick a member per row. A reference draws
   * from its own derived stream, so the pick must be reproducible from the seed
   * rather than from wherever the main generator happens to have got to.
   */
  readonly seed?: string | undefined;
  readonly dataSources?: DataSourceOptions | undefined;
  readonly packs?: PackRegistry | undefined;
  /**
   * Config-level `<distinct>` groups: each inner array holds the names of
   * scalar sequences that must produce different values from each other
   * within one row. Enforced after all sequences materialise.
   */
  readonly envDistinctGroups?: readonly (readonly string[])[] | undefined;
  /**
   * Config-level `<uniq>` groups: each inner array holds the names of scalar
   * sequences whose combined TUPLE must be unique across all rows. Enforced
   * after all sequences materialise.
   */
  readonly envUniqGroups?: readonly (readonly string[])[] | undefined;
  /**
   * Parameter overrides for a pack generator body: a local `<sequence>` whose
   * name matches a key is materialized as that constant value for every row,
   * instead of running its own spec. This is how a calling
   * `<gen type="template" value="…" p="v">` passes `p="v"` into the generator —
   * the pack author declares `<sequence name="p">…default…</sequence>` and the
   * caller value wins. Only set by `runGenerator`; top-level configs never pass
   * it, so their sequences are unaffected.
   */
  readonly overrides?: Readonly<Record<string, string>> | undefined;
  /**
   * Set by the async render path. Lets a `type="http"` generator produce a
   * placeholder column to be filled by an async post-pass; absent, it refuses to
   * render synchronously. See {@link SequenceBuildContext.httpDeferred}.
   */
  readonly httpDeferred?: boolean | undefined;
}

/**
 * Execute a data-pack generator body and return `count` values.
 *
 * - `single` → run the one primitive `<gen>` spec.
 * - `composed` → materialise the local sequences over `count` (so exact
 *   percentages, shuffle and determinism apply), then interpolate the
 *   `<data>` output template per row.
 *
 * Deterministic on the shared prng. Used from both the inline (render)
 * path and the sequence path.
 */
/**
 * Control attributes on a `<gen type="template">` that steer the call itself
 * rather than parameterize the pack generator. Everything else is a parameter
 * that may override a same-named local sequence (spec §4.1).
 */
/**
 * What the ENGINE reads off a `<gen type="template">` before the pack runs.
 *
 * This set is the authority on which names a pack may claim: anything NOT here
 * is handed to the pack as a parameter override by `paramOverrides` below, so a
 * pack is free to declare a `<sequence name="base">` and have the caller pin it.
 * The validator imports it for exactly that reason — it used to keep its own
 * idea of which names belong to which generator type, and refused `base=` on
 * `usa.finance.aba_routing`, `common.payment.card.pan` and 37 other packs that
 * declare it, with `TDC015: <gen> does not read "base"`. The engine had been
 * reading it all along.
 */
export const RESERVED_TEMPLATE_ATTRS = new Set([
  'type',
  'value',
  'local',
  'name',
  'if',
  'comment',
  'anomaly',
  'anomaly_factor',
  'anomaly_flag',
  'missing',
  'missing_as',
  'mask',
  'case',
  'order',
  'cycle',
]);

/** Extract caller parameters (non-reserved attrs) as sequence overrides. */
export function paramOverrides(attrs: AttrMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!RESERVED_TEMPLATE_ATTRS.has(key)) out[key] = value;
  }
  return out;
}

export function runGenerator(
  body: GeneratorBody,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
): string[] {
  if (body.kind === 'single') {
    return buildGenValues(body.gen, count, prng, locale, now, {
      regexMaxLength: options.regexMaxLength,
      dataSources: options.dataSources ?? {},
      packs: options.packs,
      fileRowLinks: new Map<string, LinkedFileRowPlan>(),
    });
  }

  const registry = buildSequences(body.sequences, count, prng, locale, now, options);
  if (body.validate) {
    enforceValid(body.validate, body.sequences, registry, count, prng, locale, now, options);
  }
  const out: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) {
    out[i] = interpolate(body.output, body.inject, i, registry);
  }
  return out;
}

/**
 * The date columns some offset measures from, by name.
 *
 * A date's cell holds a RENDERING — `02/03/2026` in an en locale, `03.02.2026`
 * in a ru one — and reading a date back out of that is a guess. So a column
 * another one is measured from keeps what it actually generated, and the offset
 * works from the value rather than from its spelling. Only the named columns do:
 * a config with no offset in it allocates nothing extra.
 */
function instantColumnsOf(specs: readonly SequenceSpec[]): ReadonlySet<string> {
  const wanted = new Set<string>();
  for (const spec of specs) {
    if (isDateOffset(spec)) wanted.add(offsetOf(spec));
  }
  return wanted;
}

export function buildSequences(
  specs: readonly SequenceSpec[],
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
): SequenceRegistry {
  const ctx: SequenceBuildContext = {
    regexMaxLength: options.regexMaxLength,
    dataSources: options.dataSources ?? {},
    packs: options.packs,
    fileRowLinks: new Map<string, LinkedFileRowPlan>(),
    httpDeferred: options.httpDeferred,
    seed: options.seed,
    layouts: new Map(),
    // Read lazily, so a nested <switch> sees the subject column whatever order
    // the registry filled up in — the validator has already made sure the
    // subject is declared before the switch that reads it.
    valueAt: (name, row) => {
      const seq = registry[name];
      return seq ? sequenceValueAt(seq, row) : undefined;
    },
    hasColumn: (name) => registry[name] !== undefined,
    instantColumns: instantColumnsOf(specs),
  };

  // Before a single row exists: can the uniq groups cover `count` at all? The
  // post-build check asks the same question over the finished columns, which
  // means reaching it costs the allocation this refusal is meant to save.
  checkEnvUniqCapacity(options.envUniqGroups ?? [], specs, count);

  // Built-in positional sequences. All deterministic by iteration index,
  // so they consume zero prng state and always produce the same values
  // for a given `count`.
  //
  // `_first` and `_last` store literal "true" / "false" strings. The
  // expression evaluator treats the string "false" (and the empty
  // string) as falsy, so `<data if="!_last">` still reads naturally
  // while `${{_last}}` interpolates as the human-readable word "false"
  // — useful when the user wants a literal boolean in the output,
  // e.g. `"isLast": ${{_last}}` in JSON.
  //
  // `_total` is the numeric total card count (as a string), repeated
  // on every row. It exists for callers who prefer explicit numeric
  // comparisons like `<data if="_count == _total">`, as an alternative
  // to the boolean `_last`.
  const registry: Record<string, Sequence> = {
    _count: {
      name: '_count',
      values: Array.from({ length: count }, (_, i) => String(i + 1)),
    },
    _first: {
      name: '_first',
      values: Array.from({ length: count }, (_, i) => (i === 0 ? 'true' : 'false')),
    },
    _last: {
      name: '_last',
      values: Array.from({ length: count }, (_, i) => (i === count - 1 ? 'true' : 'false')),
    },
    _total: {
      name: '_total',
      values: new Array<string>(count).fill(String(count)),
    },
  };

  for (const spec of specs) {
    // Parameter override (pack generators): a caller attribute whose name
    // matches this local sequence replaces it with a constant column. Consumes
    // no PRNG, so the rest of the body's deterministic stream is unchanged.
    const override = options.overrides?.[spec.name];
    if (override !== undefined) {
      registry[spec.name] = { name: spec.name, values: new Array<string>(count).fill(override) };
      continue;
    }
    // A reference to a <pool>: this row gets one member, and every field of
    // that member is published under `Ref.field`. Resolved HERE, in declaration
    // order, rather than in a pass afterwards — a later `<switch on="Doc.city">`
    // has to find the field already registered, exactly as it would find a
    // field of a compound declared above it.
    const refPool = poolRefName(spec);
    if (refPool !== undefined) {
      registerPoolRef(spec, refPool, registry, count, options.pools, options.seed ?? '');
      continue;
    }
    // A column derived from other columns — running, stat, formula, a date
    // offset. One rule, one place: see `derived.ts` for why they belong
    // together and what each one costs.
    if (
      registerDerivedColumn(
        spec,
        registry,
        count,
        prng,
        locale,
        ctx.instantColumns,
        options.sequential,
      )
    ) {
      continue;
    }
    if (spec.items) {
      // Composed sequence: the body in declaration order — unnamed gens and
      // literals build the value, named ones stay fields. The order is owned by
      // `drawComposed`; the draw itself is still this engine's.
      const mask = computeParentMask(spec, registry, count);
      const rows = orderedRows(spec, mask, ctx.layouts);
      const applicableCount = rows.length;
      const uniqPart = uniqDrawPart(spec.items, spec.uniq === true);
      // The stream names must be the ones `buildComposedStream` gives the same
      // body: a named field is `Name.field`, an unnamed part is `Name#pN`
      // counted among the unnamed ones only. Numbering them any other way keys
      // the same cell differently in the two engines.
      let unnamed = 0;
      const { composed, fields: produced } = drawComposed(
        spec.items,
        applicableCount,
        (item, n) => {
          const streamId =
            item.kind === 'field'
              ? `${spec.name}.${item.name}`
              : `${spec.name}#p${String(unnamed++)}`;
          return item === uniqPart
            ? buildUniqueValues(spec.name, item.gen, n, prng, locale, ctx)
            : buildGenValues(item.gen, n, prng, locale, now, withRows(ctx, streamId, rows));
        },
      );

      if (spec.distinctGroups && applicableCount > 0) {
        enforceDistinct(spec, produced, rows, prng, locale, now, ctx);
      }

      if (composesOwnValue(spec.items)) {
        registry[spec.name] = assembleAt(spec.name, rows, composed, count);
      }
      for (const [fieldName, values] of produced) {
        registry[`${spec.name}.${fieldName}`] = assembleAt(
          `${spec.name}.${fieldName}`,
          rows,
          values,
          count,
        );
      }
      continue;
    }
    if (spec.gens) {
      // Compound sequence: each field registers under the dotted key
      // `${name}.${fieldName}`. All fields share the same parent mask
      // — compute it once, then materialize each field against that
      // mask using the shared PRNG stream (in declaration order).
      const mask = computeParentMask(spec, registry, count);
      const rows = orderedRows(spec, mask, ctx.layouts);
      const applicableCount = rows.length;
      const produced = new Map<string, string[]>();
      for (const field of spec.gens) {
        produced.set(
          field.name,
          applicableCount === 0
            ? []
            : buildGenValues(
                field.gen,
                applicableCount,
                prng,
                locale,
                now,
                withRows(ctx, `${spec.name}.${field.name}`, rows),
              ),
        );
      }
      // `<distinct>` groups: repair collisions per row (see enforceDistinct).
      // Runs after all initial draws so the base PRNG stream is unchanged.
      if (spec.distinctGroups && applicableCount > 0) {
        enforceDistinct(spec, produced, rows, prng, locale, now, ctx);
      }
      // `uniq="true"`: rearrange the field columns so every row's tuple is
      // unique across the dataset. Errors before output if infeasible.
      if (spec.uniq && applicableCount > 0) {
        enforceUniqRedrawing(spec, produced, applicableCount, (gen, n) =>
          buildGenValues(gen, n, prng, locale, now, ctx),
        );
      }
      for (const field of spec.gens) {
        registry[`${spec.name}.${field.name}`] = assembleAt(
          `${spec.name}.${field.name}`,
          rows,
          produced.get(field.name) ?? [],
          count,
        );
      }
      continue;
    }
    if (spec.conditional) {
      const { sequence, flags } = materializeConditional(
        spec,
        spec.conditional,
        registry,
        count,
        prng,
        locale,
        now,
        ctx,
      );
      registry[spec.name] = sequence;
      for (const f of flags) registry[f.name] = f.sequence;
      continue;
    }
    if (spec.compute) {
      registry[spec.name] = materializeCompute(spec, spec.compute, registry, count);
      continue;
    }
    if (spec.switchSpec) {
      registry[spec.name] = materializeSwitch(
        spec,
        spec.switchSpec,
        registry,
        count,
        prng,
        locale,
        now,
        ctx,
      );
      continue;
    }
    if (spec.gen) {
      const flagName = spec.gen.attrs['anomaly_flag'];
      if (flagName) {
        // A value gen with `anomaly_flag`: build the value column while recording
        // the per-row anomaly selection, then register a companion "true"/"false"
        // sequence masked identically (undefined on parent-filtered rows).
        const mask = computeParentMask(spec, registry, count);
        const rows = orderedRows(spec, mask, ctx.layouts);
        const applicableCount = rows.length;
        const flags: string[] = [];
        const produced =
          applicableCount === 0
            ? []
            : buildGenValues(
                spec.gen,
                applicableCount,
                prng,
                locale,
                now,
                withRows(ctx, spec.name, rows),
                flags,
              );
        registry[spec.name] = assembleAt(spec.name, rows, produced, count);
        registry[flagName] = assembleAt(flagName, rows, flags, count);
      } else {
        registry[spec.name] = materializeSimple(
          spec,
          spec.gen,
          registry,
          count,
          prng,
          locale,
          now,
          ctx,
        );
      }
      continue;
    }
    if (spec.mixSpec) {
      const { sequence, flag } = materializeMixSequence(
        spec,
        spec.mixSpec,
        registry,
        count,
        prng,
        locale,
        now,
        ctx,
      );
      registry[spec.name] = sequence;
      if (flag) registry[flag.name] = flag.sequence;
    }
  }

  // Config-level `<distinct>` groups: repair collisions BETWEEN whole
  // sequences per row. Runs after all sequences materialise, so the base
  // PRNG stream is unchanged (repair draws are appended).
  if (options.envDistinctGroups && options.envDistinctGroups.length > 0) {
    enforceEnvDistinct(options.envDistinctGroups, specs, registry, count, prng, locale, now, ctx);
  }
  // Config-level `<uniq>` groups: rearrange the grouped scalar sequences so
  // their combined tuple is unique across rows. After distinct so both hold.
  if (options.envUniqGroups && options.envUniqGroups.length > 0) {
    enforceEnvUniq(options.envUniqGroups, specs, registry, count);
  }
  return registry;
}

/**
 * Conditional sequence (in-memory / Engine 1): materialize each branch's gen
 * over all rows, then per row pick the FIRST branch whose `if` is truthy (or a
 * fallback branch with no `if`). None match → the row is empty. Conditions are
 * evaluated against the registry, which already holds earlier-declared
 * sequences (parent-before-child order).
 */
function materializeConditional(
  spec: SequenceSpec,
  branches: readonly CondBranch[],
  registry: SequenceRegistry,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): { sequence: Sequence; flags: readonly { name: string; sequence: Sequence }[] } {
  // Each branch draws under its OWN stream — `Name#if0`, `Name#if1` — the ids
  // the streaming engine gives them in `buildConditionalSeq`. They used to share
  // the run's PRNG, which made a branch's values depend on how many draws the
  // columns before it had made: the same config and seed then produced different
  // data on the in-memory engine than on the streaming one.
  const built = branches.map((b, k) => {
    const flagName = (b.gen.attrs['anomaly_flag'] ?? '').trim();
    const flags: string[] | undefined = flagName === '' ? undefined : [];
    return {
      cond: b.cond,
      flagName,
      flags,
      values: buildGenValues(
        b.gen,
        count,
        prng,
        locale,
        now,
        forStreamOf(ctx, `${spec.name}#if${String(k)}`),
        flags,
      ),
    };
  });

  const values = new Array<string | undefined>(count);
  // One column per DISTINCT name: branches sharing `anomaly_flag="IsOutlier"`
  // share the column, which is the point of writing it on each branch.
  const flagCols = new Map<string, (string | undefined)[]>();
  for (const b of built) {
    if (b.flagName !== '' && !flagCols.has(b.flagName)) {
      flagCols.set(b.flagName, new Array<string | undefined>(count));
    }
  }

  for (let i = 0; i < count; i++) {
    const winner = built.find((b) => b.cond === undefined || evaluateIf(b.cond, registry, i));
    values[i] = winner?.values[i];
    // No branch matched: the row is not covered, so neither the value nor any
    // claim about it exists. Every flag column stays `undefined` here, masked
    // exactly like the value.
    if (!winner) continue;
    for (const [name, col] of flagCols) {
      // A covered row always has an answer. `false` — not empty — when the
      // branch that produced it cannot spike at all, because "no outlier" is
      // the truth about that row, and a detector scored against the column
      // needs it stated rather than left blank.
      col[i] = winner.flagName === name ? (winner.flags?.[i] ?? 'false') : 'false';
    }
  }

  return {
    sequence: { name: spec.name, values },
    flags: [...flagCols].map(([name, vals]) => ({ name, sequence: { name, values: vals } })),
  };
}

function materializeSimple(
  spec: SequenceSpec,
  gen: GenSpec,
  registry: SequenceRegistry,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): Sequence {
  const mask = computeParentMask(spec, registry, count);
  const rows = orderedRows(spec, mask, ctx.layouts);
  const applicableCount = rows.length;

  // A template whose `value` interpolates a sibling field (`common.vehicle.model.${{Brand}}`)
  // resolves its address per row from the registry — the child pack is the one the
  // parent named on that row. Engine-1 only; streaming defers it (see render.ts).
  if (gen.type === 'template' && isDynamicTemplateValue(gen.attrs['value'] ?? '')) {
    const produced = buildDynamicTemplateValues(gen, rows, registry, prng, locale, now, ctx);
    return assembleAt(spec.name, rows, produced, count);
  }

  // `uniq="true"` on a simple sequence: a draw WITHOUT REPLACEMENT. A single
  // column has no room to be both proportional and unique, so — unlike the
  // compound path, which only rearranges — uniq changes the draw here.
  // `increment`/`decrement` are unique by construction and keep their build.
  if (spec.uniq === true && gen.type !== 'increment' && gen.type !== 'decrement') {
    const produced =
      applicableCount === 0
        ? []
        : buildUniqueValues(spec.name, gen, applicableCount, prng, locale, ctx);
    return assembleAt(spec.name, rows, produced, count);
  }

  // A column some `<gen type="date" of="…">` measures from keeps the instant it
  // generated beside the text it renders. Nothing else asks, so nothing else
  // allocates — and the array is built in the compacted order `produced` is in,
  // then spread over the real rows by `assembleAt`, exactly like the values.
  const wantsInstants = gen.type === 'date' && ctx.instantColumns?.has(spec.name) === true;
  const instants: (number | undefined)[] | undefined = wantsInstants ? [] : undefined;

  const produced =
    applicableCount === 0
      ? []
      : buildGenValues(
          gen,
          applicableCount,
          prng,
          locale,
          now,
          withRows(ctx, spec.name, rows),
          undefined,
          instants,
        );

  const sequence = assembleAt(spec.name, rows, produced, count);
  // Attach the instants only if the build actually filled them for every row.
  //
  // A sink that was asked for and left empty is NOT "this column has no date on any row" —
  // it is "this build never wrote one", and the two answers are opposite. Reading an empty
  // sink as the first gave a silent empty column for a walked axis and for a repeating date,
  // from configs that were right; refusing to attach gives the text reading instead, which
  // either works or names the problem out loud. Any path added later that forgets the sink
  // now degrades the same safe way.
  const filled = instants?.length === applicableCount;
  return filled ? { ...sequence, instants: spreadInstants(rows, instants, count) } : sequence;
}

/** Put each drawn instant on the row its value landed on. */
function spreadInstants(
  rows: readonly number[],
  instants: readonly (number | undefined)[],
  count: number,
): (number | undefined)[] {
  const out = new Array<number | undefined>(count).fill(undefined);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined) out[row] = instants[i];
  }
  return out;
}

/**
 * Materialize a `<mix>` sequence, plus — when it declares `flag="NAME"` — the
 * ground-truth companion column marking rows that chose an `anomaly="true"`
 * branch. Both share one mask, so the label is `undefined` on exactly the rows
 * the value is.
 */
function materializeMixSequence(
  spec: SequenceSpec,
  mixSpec: MixSpec,
  registry: SequenceRegistry,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): { sequence: Sequence; flag?: { name: string; sequence: Sequence } } {
  const mask = computeParentMask(spec, registry, count);
  const rows = orderedRows(spec, mask, ctx.layouts);
  const applicableCount = rows.length;
  const flagName = mixSpec.attrs['flag'];
  const flags: boolean[] | undefined = flagName ? [] : undefined;

  const produced =
    applicableCount === 0
      ? []
      : buildMixValues(
          mixSpec,
          applicableCount,
          prng,
          locale,
          now,
          // The `#switch` suffix is a stable historical PRNG key — the streaming
          // engine uses it verbatim so a `<mix>` keeps the values of the
          // `<switch>` it replaced. Both engines must spell it the same way.
          withRows(ctx, `${spec.name}#switch`, rows),
          flags,
        );

  const sequence = assembleAt(spec.name, rows, produced, count);
  if (flagName === undefined || flags === undefined) return { sequence };
  return {
    sequence,
    flag: {
      name: flagName,
      sequence: assembleAt(
        flagName,
        rows,
        flags.map((b) => (b ? 'true' : 'false')),
        count,
      ),
    },
  };
}

/**
 * Maximum redraws for a single `<distinct>` field before giving up. A
 * high bound so legitimate small pools still resolve, but finite so an
 * impossible constraint (e.g. a 1-value source in a 2-field group) fails
 * fast with a clear error instead of hanging.
 */
const DISTINCT_FUSE = 1000;

/**
 * Enforce `<distinct>` groups on a compound sequence's materialized fields.
 *
 * For each group and each applicable row, walk the group's fields in
 * declaration order: the first is accepted as-is; each subsequent field
 * whose value already appeared in that row's group is redrawn (one fresh
 * draw from its own `<gen>` on the shared PRNG) until it differs. Mutates
 * the arrays in `produced` in place.
 *
 * Deterministic: row order and field order are fixed, and repair draws are
 * appended after the initial stream, so output is reproducible. Throws a
 * clear error if a field cannot be made distinct within the fuse.
 */
function enforceDistinct(
  spec: SequenceSpec,
  produced: Map<string, string[]>,
  rows: readonly number[],
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): void {
  const keyed = keyedDraws(ctx);
  const redraw = redrawCtx(ctx);
  const genByField = new Map<string, GenSpec>();
  for (const field of spec.gens ?? []) genByField.set(field.name, field.gen);

  for (const group of spec.distinctGroups ?? []) {
    const fields = group.filter((f) => produced.has(f) && genByField.has(f));
    if (fields.length < 2) continue;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] ?? i;
      const seen = new Set<string>();
      for (const fieldName of fields) {
        const values = produced.get(fieldName);
        const gen = genByField.get(fieldName);
        if (!values || !gen) continue;
        let value = values[i] ?? '';
        let attempts = 0;
        while (seen.has(value)) {
          if (attempts >= DISTINCT_FUSE) {
            throw new Error(
              `<distinct> in sequence "${spec.name}": could not find a value for field ` +
                `"${fieldName}" different from the others after ${String(DISTINCT_FUSE)} attempts — ` +
                'its source likely has too few distinct values.',
            );
          }
          attempts += 1;
          // Each attempt has a stream of its own, named for the field and the
          // attempt number — the same names the streaming engine redraws under,
          // so both engines land on the same replacement.
          const draw = keyed
            ? seekableGen(keyed.seed, `${spec.name}.${fieldName}#d${String(attempts)}`, row)
            : prng;
          value = buildGenValues(gen, 1, draw, locale, now, keyed ? redraw : ctx)[0] ?? '';
        }
        values[i] = value;
        seen.add(value);
      }
    }
  }
}

/**
 * The generator context is invariant per render (it depends only on `options`),
 * but the streaming path calls `resolveGenValueAt` once PER ROW per field —
 * allocating a fresh context + `Map` each time was pure GC pressure. Cache it
 * by the `options` object (stable across a render). `fileRowLinks` is shared
 * across the render, matching Engine 1's single shared context.
 */
const streamCtxCache = new WeakMap<SequenceBuildOptions, SequenceBuildContext>();

export function streamCtx(options: SequenceBuildOptions): SequenceBuildContext {
  const cached = streamCtxCache.get(options);
  if (cached) return cached;
  const ctx: SequenceBuildContext = {
    regexMaxLength: options.regexMaxLength,
    dataSources: options.dataSources ?? {},
    packs: options.packs,
    fileRowLinks: new Map<string, LinkedFileRowPlan>(),
    perRow: true,
    // A sibling column, read lazily. The streaming builder already fills this in
    // its options — it is how a `<switch>` inside a `<case>` finds its subject —
    // and a distribution parameter written as an expression needs exactly the
    // same thing, so it is carried through rather than invented again.
    valueAt: options.valueAt,
    hasColumn: options.hasColumn,
  };
  streamCtxCache.set(options, ctx);
  return ctx;
}

/**
 * Produce `count` values for a gen, then apply `anomaly` and `missing` (MCAR)
 * if set — one extra PRNG draw per row, so it's deterministic. This is the
 * in-memory (Engine 1) path; independent gens in streaming reach it via
 * `resolveGenValueAt`, while the inline-built streaming types (text, counters,
 * timeseries, pattern) apply the same two modifiers seekably in stream-build.ts
 * (`missingAnomalyMod`).
 */
export function buildGenValues(
  gen: GenSpec,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  flagTextOut?: string[],
  instantsOut?: (number | undefined)[],
): string[] {
  // Row by row, off the very stream the streaming engine uses, so the two
  // engines produce the same bytes from one seed. `gen-resolve.ts` already
  // calls THIS function that way — one row, `seekableGen(seed, streamId, i)` —
  // so there is no second implementation to keep in step, only the same one
  // called the same way. The recursive call has count = 1, which the guard
  // refuses, and that is what stops this from looping.
  if (perRowBuildable(gen, count, ctx, locale)) {
    const seed = ctx.seed ?? '';
    const streamId = ctx.streamId ?? '';
    const out = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      const flags: string[] | undefined = flagTextOut ? [] : undefined;
      // One row's instant lands at index 0 of its own scratch: the recursive
      // call knows nothing of `i`, and reusing `instantsOut` here would have
      // every row overwrite slot 0 before it was copied out.
      const one: (number | undefined)[] | undefined = instantsOut ? [] : undefined;
      const row = ctx.rows ? (ctx.rows[i] ?? i) : i;
      // The one-row build carries the row it IS. Without this the inner call
      // sees the whole `rows` array and reads position 0 out of it, so anything
      // asking "which row am I" — a distribution parameter written as an
      // expression — answered "the first" on every row. The streaming path
      // already narrowed this way (`resolveGenValueAt`), and the two engines
      // disagreeing about the same question is what made it visible.
      const rowCtx = { ...ctx, rows: [row] };
      out[i] =
        buildGenValues(
          gen,
          1,
          seekableGen(seed, streamId, row),
          locale,
          now,
          rowCtx,
          flags,
          one,
        )[0] ?? '';
      if (flagTextOut && flags) flagTextOut[i] = flags[0] ?? 'false';
      if (instantsOut && one) instantsOut[i] = one[0];
    }
    return out;
  }

  const repeat = parseRepeat(gen.attrs);
  if (!repeat) {
    const flags: boolean[] | undefined = flagTextOut ? [] : undefined;
    const out = buildGenValuesOnce(gen, count, prng, locale, now, ctx, flags, true, instantsOut);
    if (flagTextOut && flags) {
      for (let i = 0; i < count; i++) flagTextOut[i] = flags[i] === true ? 'true' : 'false';
    }
    return out;
  }

  const keyed = keyedDraws(ctx);
  if (keyed) {
    // A listed column lays every element of every row out at once and reads the
    // slots the length plan gave the row; anything drawn takes one sub-stream
    // per element. Which of the two is the streaming engine's own split.
    const listed = listedValues(gen, ctx, locale);
    return listed
      ? buildKeyedRepeatLayout(
          repeat,
          listed.values,
          listed.percents,
          count,
          ctx,
          keyed.seed,
          keyed.streamId,
          elementModifier(gen, repeat, keyed.seed, keyed.streamId),
        )
      : buildKeyedRepeatDraws(
          gen,
          repeat,
          count,
          locale,
          now,
          ctx,
          keyed.seed,
          keyed.streamId,
          flagTextOut,
        );
  }

  return buildRepeatedValues(
    repeat,
    count,
    prng,
    (n, flagsOut) => buildGenValuesOnce(gen, n, prng, locale, now, ctx, flagsOut),
    flagTextOut,
  );
}

/**
 * `anomaly=`, `missing=` and the formatting layer applied to ONE element of a
 * repeating listed column. The two probability draws come off the row's `#anom`
 * and `#miss` streams with a budget of the row's maximum length, so element k
 * always gets the same uniform however long its row turned out to be.
 */
function elementModifier(
  gen: GenSpec,
  repeat: RepeatSpec,
  seed: string,
  streamId: string,
): ((row: number, value: string, k: number) => string) | undefined {
  const anomaly = parseAnomaly(gen.attrs);
  const missing = parseMissing(gen.attrs);
  const fmt = genFormatter(gen.attrs['mask'], gen.attrs['case']);
  const hasAnomaly = anomaly !== undefined && anomaly.p > 0;
  const hasMissing = missing !== undefined && missing.p > 0;
  if (!hasAnomaly && !hasMissing && !fmt) return undefined;

  const anomAt = hasAnomaly ? keyedElementUniforms(seed, streamId, '#anom', repeat.max) : undefined;
  const missAt = hasMissing ? keyedElementUniforms(seed, streamId, '#miss', repeat.max) : undefined;
  return (row, value, k) => {
    let out = value;
    if (anomaly && anomAt && anomAt(row, k) < anomaly.p) {
      const n = Number(out);
      // The `repeat=` path spikes each ELEMENT here rather than through
      // `applyAnomaly`, and used to re-stringify — so a repeated column lost the
      // shape the plain one kept: `rep=[73.5,73.5]` beside a plain `73.50`.
      if (Number.isFinite(n)) out = keepShape(out, n * anomaly.factor);
    }
    if (missing && missAt && missAt(row, k) < missing.p) out = missing.token;
    return fmt ? fmt(out) : out;
  };
}

function buildGenValuesOnce(
  gen: GenSpec,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  anomalyFlagsOut?: boolean[],
  rowKeyed = false,
  instantsOut?: (number | undefined)[],
): string[] {
  const values = buildGenValuesRaw(gen, count, prng, locale, now, ctx, instantsOut);
  // The inline-built types never reach the per-row path — their value follows
  // the position — so their two modifier draws are keyed here, on the same
  // `#anom` and `#miss` streams the streaming engine uses. Every other type got
  // there through `seekableGen` already and must keep drawing off it in order.
  const keyed = rowKeyed && INLINE_ANOMALY_TYPES.has(gen.type) ? keyedDraws(ctx) : undefined;
  const drawOn = (purpose: string): ((i: number) => number) =>
    keyed
      ? (i) =>
          seekableUniforms(keyed.seed, `${keyed.streamId}${purpose}`, absoluteRow(ctx, i), 1)[0] ??
          1
      : () => prng();
  const anomaly = parseAnomaly(gen.attrs);
  const spiked = anomaly ? applyAnomaly(values, anomaly, drawOn('#anom'), anomalyFlagsOut) : values;
  const missing = parseMissing(gen.attrs);
  // `applyMissing` blanks IN PLACE and hands back the same array, so the two
  // "did this row get blanked" tests below cannot ask by identity — they would
  // compare an array with itself and never fire. Snapshot first, and only when
  // someone is actually asking.
  const beforeMissing =
    missing && (instantsOut ?? anomalyFlagsOut) ? Array.from(spiked) : undefined;
  const withMissing = missing ? applyMissing(spiked, missing, drawOn('#miss')) : spiked;
  // A blanked cell keeps neither of the two things computed beside it. The INSTANT
  // goes because a column measuring from this one would otherwise produce a date on
  // a row whose source says nothing; the anomaly FLAG goes because it is the label a
  // detector is scored against, and `true` beside an empty cell teaches it something
  // untrue. (`mask=`/`case=` below change only the SPELLING, which both outlive.)
  if (beforeMissing) {
    for (let i = 0; i < count; i++) {
      if (withMissing[i] === beforeMissing[i]) continue;
      if (instantsOut) instantsOut[i] = undefined;
      if (anomalyFlagsOut) anomalyFlagsOut[i] = false;
    }
  }
  // Output formatting: `mask=`/`case=` post-process each value (mask then case).
  const fmt = genFormatter(gen.attrs['mask'], gen.attrs['case']);
  return fmt ? withMissing.map((v) => fmt(v)) : withMissing;
}

/**
 * The ordered value list of a list-backed generator, for `order="sequential"`:
 * `text` splits its `value`, `file` loads its lines (or a CSV column) as-is.
 */
export function sequentialList(gen: GenSpec, dataSources: DataSourceOptions): string[] {
  if (gen.type === 'file') {
    const resolved = resolveExistingDataSourcePath(gen.attrs['src'] ?? '', dataSources).path;
    const column = gen.attrs['column'];
    const options = { column, header: gen.attrs['header'], delimiter: gen.attrs['delimiter'] };
    return column && column.trim().length > 0
      ? loadCsvColumnFile(resolved, options)
      : loadListFile(resolved);
  }
  return (gen.attrs['value'] ?? '').split(',').map((s) => s.trim());
}

/**
 * Which of `size` values row `index` gets: `index mod size` (loop), or an error
 * past the end when `cycle=false`.
 *
 * The one place that decides, so a text list, a file column and a walked date
 * range answer the same way — and say the same thing when they run out. A date
 * range never becomes a list (a century by the second is not a list anyone
 * should hold), which is why this takes a SIZE rather than the values.
 */
export function sequentialIndex(size: number, index: number, cycle: boolean): number {
  if (size <= 0) return 0;
  if (!cycle && index >= size) {
    // Say which ROW ran out, not how many rows were asked for: the streaming path
    // resolves one row at a time and does not know the run's size here. The old
    // wording read "only 4 values for 5 rows" on a config that said count="6",
    // so the one number a reader would take to their config was the wrong one.
    throw new Error(
      `order="sequential" cycle="false": the source has only ${String(size)} values, ` +
        `so row ${String(index + 1)} has none — shorten count= or lengthen the source`,
    );
  }
  return index % size;
}

/** Pick element `index mod N` (loop), or error past the end when `cycle=false`. */
export function pickSequential(list: readonly string[], index: number, cycle: boolean): string {
  if (list.length === 0) return '';
  return list[sequentialIndex(list.length, index, cycle)] ?? '';
}

function buildGenValuesRaw(
  gen: GenSpec,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  instantsOut?: (number | undefined)[],
): string[] {
  // order="sequential": emit list/file values in order (looping), ignoring the
  // random pick and any `percent`. Row i → element i mod N.
  if ((gen.type === 'text' || gen.type === 'file') && gen.attrs['order'] === 'sequential') {
    const list = sequentialList(gen, ctx.dataSources);
    const cycle = gen.attrs['cycle'] !== 'false';
    return Array.from({ length: count }, (_, i) => pickSequential(list, i, cycle));
  }
  // The same rule over a date range: row i → the i-th step from the start. The
  // axis is arithmetic, not a list, so a long range costs nothing to walk.
  if (gen.type === 'date' && gen.attrs['order'] === 'sequential') {
    const axis = dateAxis(gen.attrs, locale, now);
    const cycle = gen.attrs['cycle'] !== 'false';
    // An OPEN axis has no size and never wraps: row i is simply the i-th step.
    const stepAt = (i: number): number =>
      axis.size === undefined ? i : sequentialIndex(axis.size, i, cycle);
    // A WALKED date keeps its instant too. It is the pairing a real record asks for most —
    // orders march down the calendar, delivery is a few days after its own order — and this
    // branch returns before the drawn-date one, so without this the sink stayed empty and the
    // offset read every row as "this row has no date". A silent empty column, from a config
    // that was right.
    if (instantsOut) {
      for (let i = 0; i < count; i++) instantsOut[i] = toEpochMillis(axis.valueAt(stepAt(i)));
    }
    return Array.from({ length: count }, (_, i) => axis.at(stepAt(i)));
  }
  switch (gen.type) {
    case 'text': {
      const valueAttr = gen.attrs['value'] ?? '';
      const values = valueAttr.split(',').map((s) => s.trim());
      const percentAttr = gen.attrs['percent'];
      // The streaming engine has NO separate uniform path: no `percent=` simply
      // means equal shares, and either way it lays the values out exactly over
      // the column and then permutes. Doing the same here is what makes a text
      // column come out the same on every engine — and it is one mechanism, not
      // a random pick plus a quota plan.
      const exact = exactTextLayout(values, percentAttr, count, ctx);
      if (exact) return exact;
      if (percentAttr) {
        const percents = expandPercentMask(percentAttr, values.length);
        return distributeByPercent({ count, values, percents, prng }).slice();
      }
      return textUniform(values)(count, prng).slice();
    }
    case 'file': {
      return buildFileValues(gen, count, prng, ctx);
    }
    case 'template': {
      const path = gen.attrs['value'] ?? '';
      // A `${{Field}}`-interpolated address is resolved per row by the in-memory
      // engine (materializeSimple). Reaching HERE means a lazy/exact path tried to
      // resolve it statically — defer so the caller falls back to Engine 1.
      if (isDynamicTemplateValue(path)) {
        throw new StreamUnsupportedError(
          `template value "${path}" interpolates a field; the in-memory engine resolves it per row`,
        );
      }
      // Soft/hard locale resolution: a bare address is relative to the
      // (gen or env) locale; a locale-prefixed address is absolute. Data-pack
      // addresses take precedence over builtin template paths. A pack
      // GENERATOR runs its stored <gen> spec; a pack DATA list is a uniform pick.
      const packEntry = ctx.packs?.get(resolvePackAddress(path, gen.attrs['local'] ?? locale));
      if (packEntry?.generator) {
        // A whole-column quota inside the pack — a `percent=` its body declares,
        // or a weighted list its body DRAWS from. Row at a time, the quota is
        // computed over one row and every row goes to the largest share: wrong,
        // and silently so.
        //
        // The message used to say "declares a share (percent=)", which named
        // only the first of the two and so misdescribed twelve full-name packs
        // that carry no percent= anywhere. Engine selection routes such a config
        // to the in-memory engine and `buildLazyRegistry` refuses it up front;
        // this is the last backstop, for a path that reaches here anyway.
        // A body the lazy builder can plan over the column no longer needs this
        // backstop; one carrying its own `<valid>` still does, because rejecting
        // a row and redrawing it is a whole-column decision with no lazy form.
        if (
          ctx.perRow &&
          packEntry.needsWholeColumn === true &&
          packEntry.generator.kind === 'composed' &&
          packEntry.generator.validate !== undefined
        ) {
          throw new StreamUnsupportedError(
            `pack generator "${path}" has a value apportioned across the whole column — ` +
              'either a share its body declares or a weighted list its body draws from — ' +
              'which the streaming engines cannot do row by row. Use mode="memory" or omit ' +
              'the engine override.',
          );
        }
        /*
         * The body gets a SEED and a stream identity, like every other sequence.
         *
         * It used to get neither, and the body's inner sequences keyed their
         * draws off the empty string while taking their tie-breaks from the
         * shared sequential prng. So a weighted pack column MOVED when an
         * unrelated sequence was added in front of it — measured on x,y,z at
         * 50/30/20, seed `s`: `y y x x y y …` alone against `x y x x x y …`
         * behind a `<uniq>` — and with no stream identity the body could not be
         * planned over a column at all, which is why every whole-column pack
         * went to the in-memory engine.
         *
         * The ROW is part of the salt when this body is being built for one row,
         * and that is not a detail. A pack that does NOT need the whole column
         * is built per row at `count = 1` — the outer `<gen type="template">` is
         * itself a per-row type. Handed a column-wide seed at count 1, the
         * body's own exact-layout machinery plans one slot and gives it to one
         * value, so every row draws the same: `usa.finance.aba_routing` came out
         * as six numbers all starting `27`, where its 37-value prefix list
         * should vary. Salting with the row keeps each one-row build its own
         * draw; a body planned over the whole column has no row to salt with and
         * gets the column's seed, which is what makes it identical on all three
         * engines.
         */
        const bodyRow = count === 1 && ctx.rows?.length === 1 ? ctx.rows[0] : undefined;
        const bodySeed =
          `${ctx.seed ?? ''}|${ctx.streamId ?? ''}` +
          (bodyRow === undefined ? '' : `|${String(bodyRow)}`);
        return runGenerator(packEntry.generator, count, prng, locale, now, {
          regexMaxLength: ctx.regexMaxLength,
          dataSources: ctx.dataSources,
          packs: ctx.packs,
          overrides: paramOverrides(gen.attrs),
          seed: bodySeed,
        }).slice();
      }
      if (packEntry?.values) {
        // A WEIGHTED pack is drawn to an exact Hamilton quota — the same path
        // `percent=` and `weight=` use — so `Smith` gets its Census share, not
        // a uniform one. A plain pack stays a uniform pick.
        return packEntry.percents
          ? (exactTextLayout(packEntry.values, undefined, count, ctx, packEntry.percents) ??
              distributeByPercent({
                count,
                values: [...packEntry.values],
                percents: [...packEntry.percents],
                prng,
              }))
          : textUniform(packEntry.values)(count, prng).slice();
      }
      const source = resolveTemplate(path);
      if (!source) {
        throw new Error(`sequence: unknown template path "${path}"`);
      }
      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        out.push(source(prng, gen.attrs, locale, now));
      }
      return out;
    }
    case 'number': {
      const distAttr = gen.attrs['distribution'];
      if (distAttr !== undefined && distAttr.trim() !== '') {
        // Distribution mode: each row draws a FIXED number of uniforms from the
        // (sequential, in-memory) PRNG, so it stays deterministic; the streaming
        // engine supplies the same shape of draws seekably. A parameter written
        // as an EXPRESSION follows the row — see `dist-params.ts` for why that
        // is safe here and was not for `repeat=`.
        return distributionColumn(gen.attrs, count, prng, ctx);
      }
      const lengthAttr = gen.attrs['length'];
      const firstZeroAttr = gen.attrs['first_zero'];
      const numGen = numberGenerator({
        range: gen.attrs['value'],
        length: lengthAttr,
        percent: gen.attrs['percent'],
        firstZero: firstZeroAttr === undefined ? undefined : firstZeroAttr !== 'false',
        include: gen.attrs['include'],
        exclude: gen.attrs['exclude'],
        decimals: gen.attrs['decimals'],
      });
      return numGen(count, prng).slice();
    }
    case 'regex': {
      const regexGen = regexGenerator({
        pattern: gen.attrs['value'] ?? '',
        regexMaxLength: gen.attrs['regex_max_length'] ?? ctx.regexMaxLength,
      });
      return regexGen(count, prng).slice();
    }
    case 'advanced_regex': {
      const advancedRegexGen = advancedRegexGenerator({
        pattern: gen.attrs['value'] ?? '',
        regexMaxLength: gen.attrs['regex_max_length'] ?? ctx.regexMaxLength,
      });
      return advancedRegexGen(count, prng).slice();
    }
    case 'symbol': {
      const symGen = symbolGenerator({
        alphabet: gen.attrs['alphabet'],
        value: gen.attrs['value'],
        include: gen.attrs['include'],
        exclude: gen.attrs['exclude'],
        length: gen.attrs['length'],
      });
      return symGen(count, prng).slice();
    }
    case 'date': {
      const dGen = dateGenerator(
        {
          value: gen.attrs['value'],
          from: gen.attrs['from'],
          to: gen.attrs['to'],
          range: gen.attrs['range'],
          format: gen.attrs['format'],
          local: gen.attrs['local'],
          oldest: gen.attrs['oldest'],
          youngest: gen.attrs['youngest'],
          precision: gen.attrs['precision'],
        },
        locale,
        now,
        instantsOut,
      );
      return dGen(count, prng).slice();
    }
    case 'increment':
    case 'decrement': {
      const start = gen.attrs['value'] === undefined ? undefined : Number(gen.attrs['value']);
      const step = gen.attrs['step'] === undefined ? undefined : Number(gen.attrs['step']);
      const cGen =
        gen.type === 'increment'
          ? incrementGenerator({ start, step })
          : decrementGenerator({ start, step });
      return cGen(count, prng).slice();
    }
    case 'timeseries': {
      // Index-dependent (like counters): value(i) uses the row index; noise is a
      // per-row standard-normal draw (2 uniforms) when present.
      const spec = parseTimeseries(gen.attrs);
      const noisy = timeseriesHasNoise(spec);
      const keyed = keyedDraws(ctx);
      const out = new Array<string>(count);
      for (let i = 0; i < count; i++) {
        let z = 0;
        if (noisy) {
          // The value follows the position; the noise follows the row, on the
          // dedicated `:ts` stream the streaming engine uses. Same two names,
          // same two uniforms, same series.
          const [u1 = 0.5, u2 = 0.5] = keyed
            ? seekableUniforms(keyed.seed, `${keyed.streamId}:ts`, absoluteRow(ctx, i), 2)
            : [openUnit(prng()), openUnit(prng())];
          z = standardNormal(u1, u2);
        }
        out[i] = formatTimeseries(timeseriesValueAt(spec, i, z), spec.decimals);
      }
      return out;
    }
    case 'pattern': {
      // A drawn curve stretched over the cards: card i reads it at t = i/(count−1).
      // Signal = deterministic; corridor = one uniform per card (random in band).
      // Index-dependent (like counters) — streaming special-cases it too.
      const pg = patternGenForGen(gen, ctx.dataSources);
      const draws = patternGenDraws(pg);
      const keyed = keyedDraws(ctx);
      const out = new Array<string>(count);
      const denom = count > 1 ? count - 1 : 1;
      for (let i = 0; i < count; i++) {
        // As with timeseries: the curve is read at the position, the one draw
        // inside the band is keyed by the row on the streaming engine's `:pat`
        // stream.
        const u = !draws
          ? 0
          : keyed
            ? (seekableUniforms(keyed.seed, `${keyed.streamId}:pat`, absoluteRow(ctx, i), 1)[0] ??
              0.5)
            : openUnit(prng());
        out[i] = patternGenValue(pg, i / denom, u);
      }
      return out;
    }
    case 'http': {
      // A network-backed generator. It cannot run inside this synchronous
      // builder, so the async render path sets `httpDeferred` and fills the
      // column in a post-pass (resolveHttpSequences). Off that path it refuses,
      // rather than hand back a column of silent placeholders.
      if (ctx.httpDeferred !== true) {
        throw new Error(
          'gen type "http" makes a network call and cannot be rendered synchronously — ' +
            'use the CLI, or the async render path (renderAsync / toStringAsync).',
        );
      }
      return new Array<string>(count).fill('');
    }
    default:
      throw new Error(`sequence: gen type "${gen.type}" not yet supported`);
  }
}
