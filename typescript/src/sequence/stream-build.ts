/**
 * Lazy sequence registry for Engine 2 (streaming to disk).
 *
 * Each sequence gets a `resolve(i)` computed on demand from the seekable PRNG
 * / Feistel primitives — memory O(#sequences), not O(count). The render loop
 * and disk writer are unchanged (they read via `sequenceValueAt`).
 *
 * Parent-child (nesting, doc 29): a finite-value (text) sequence lays its
 * values into a sorted quota plan and scatters them with `permute` — exact
 * distribution, no array. A child `parent="P.V"` is active exactly on the
 * rows whose parent slot lands in V's range, and its rank WITHIN that subset
 * is `slot − lo_V` — a bijection over `[0, M_V)`. That rank is the child's own
 * population index, so the same construction nests to any depth.
 *
 * uniq: this engine does not do it, in any form. It once built a compound
 * `uniq="true"` out of a mixed-radix bijection, and the description of that
 * construction outlived the construction itself — long enough for the
 * documentation to be written from this comment and promise streaming
 * uniqueness the router never delivers. `uniq` was redefined as a
 * rearrangement of a whole finished column, which is the one thing a lazy
 * per-row resolver cannot see, so every shape of it is refused here by name
 * and the router sends it to Engine 1 or Engine 3 instead.
 *
 * Scope: simple + compound sequences; text/percent (exact), counters, and
 * independent generators (number/date/regex/symbol/template via a per-row
 * seekable draw); parent-child; in-sequence + env-level `<distinct>` (per-row
 * repair); `<mix>` (exact case %, gens + nested mixes per row). Parents must
 * be finite-value (text) sequences; `parent` must name a value (`P.V`).
 */

import { advancedRegexHasWeightedChoice } from '../generators/advanced-regex.js';
import { evaluateCompute } from '../compute/index.js';
import { genFormatter } from '../format/transforms.js';
import { computeCountsPerValue } from '../distribution/hamilton.js';
import { evaluateIf } from '../expr/evaluate.js';
import { expandPercentMask } from '../distribution/percent-mask.js';
import { patternGenDraws, patternGenValue } from '../generators/pattern.js';
import {
  formatTimeseries,
  parseTimeseries,
  standardNormal,
  timeseriesHasNoise,
  timeseriesValueAt,
} from '../generators/timeseries.js';
import { parseAnomaly } from '../generators/anomaly.js';
import { parseMissing } from '../generators/missing.js';
import { permute, permuteKey } from '../prng/permute.js';
import { INLINE_ANOMALY_TYPES } from './per-row.js';
import { buildMixSeq } from './stream-mix.js';
import { lazy } from './stream-lazy.js';
import { poolRefName } from './pool.js';
import { lazyPoolRefColumns } from './pool-ref.js';
import { createPrng } from '../prng/prng.js';
import { seekableInt, seekableUniforms } from '../prng/seekable.js';
import { csvColumnCell } from '../generators/file.js';
import { resolveExistingDataSourcePath } from '../data-source/index.js';

import {
  patternGenForGen,
  pickSequential,
  sequentialList,
  type SequenceBuildOptions,
} from './build.js';
import { resolveGenAnomalyFlagTextAt, resolveGenValueAt } from './gen-resolve.js';
import { loadWeightedValues, weightColumnOf } from '../generators/weighted.js';
import {
  joinParts,
  joinPartsOpt,
  parseRepeat,
  planRepeat,
  repeatLengthPercents,
  withoutRepeat,
} from './repeat.js';
import type { NumberLengthChoice } from '../generators/number.js';
import { numberLengthChoicesOf, pinLength, weightedTemplatePack } from './stream-weighted.js';
import { prepareRowLinkedFileSource } from './row-link.js';
import { arrangeExactUniq, type ExactUniqField } from './exact-uniq.js';
import { counterValueAt } from './stream-resolve.js';
import { buildComposedStream, composesOwnValue } from './composed.js';
import { sequenceValueAt } from './types.js';
import type {
  CaseSpec,
  CondBranch,
  GenSpec,
  Sequence,
  SequenceRegistry,
  SequenceSpec,
  SwitchSpec,
} from './types.js';

/** Max redraws before a `<distinct>` row is declared unsatisfiable (matches Engine 1). */
const DISTINCT_FUSE = 1000;

/** What a finite-value sequence exposes so its children can nest under it. */
interface ParentCapable {
  hasValue(value: string): boolean;
  /** Subset size (Hamilton quota) for `value` — a child's domain. */
  quotaOf(value: string): number;
  /** Row `i`'s rank within `value`'s subset, or undefined if `i` isn't in it. */
  childRankAt(i: number, value: string): number | undefined;
}

/** Where a sequence's population index for row `i` comes from. */
export interface Domain {
  readonly size: number;
  readonly popIndexAt: (i: number) => number | undefined;
}

/** Env-level `<uniq>` / `<distinct>` groups (across separate sequences). */
export interface EnvGroups {
  readonly uniq: readonly (readonly string[])[];
  readonly distinct: readonly (readonly string[])[];
}

export function buildLazyRegistry(
  specs: readonly SequenceSpec[],
  count: number,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions = {},
  envGroups: EnvGroups = { uniq: [], distinct: [] },
  /** Engine 3: allow percent+uniq via exact-% construction + verification. */
  exactUniq = false,
): SequenceRegistry {
  const registry: Record<string, Sequence> = {
    _count: lazy('_count', (i) => String(i + 1)),
    _first: lazy('_first', (i) => (i === 0 ? 'true' : 'false')),
    _last: lazy('_last', (i) => (i === count - 1 ? 'true' : 'false')),
    _total: lazy('_total', () => String(count)),
  };
  const parents = new Map<string, ParentCapable>();

  // A `<uniq>` group REARRANGES whole columns so each keeps its multiset — a
  // promise about the finished column, which no engine can keep a row at a
  // time. This one could only offer something else (a bijection over the
  // combination space, uniform over combinations, ignoring the values actually
  // drawn), and one seed would then mean two datasets. It says so instead. The
  // router sends every uniq to the exact engine; this is the backstop for a
  // forced one.
  for (const group of envGroups.uniq) {
    throw unsupported('<uniq> across sequences (a whole-column rearrangement)', group.join(' × '));
  }

  const specByName = new Map(specs.map((s) => [s.name, s]));

  for (const spec of specs) {
    // A reference to a <pool>. The table was computed before the run, so only
    // the per-row PICK happens here — and it is seekable, so it costs the
    // streaming engines nothing. A reference under a parent needs the parent's
    // materialised column to know which rows exist at all, so that one goes to
    // the in-memory engine rather than being guessed at.
    const refPool = poolRefName(spec);
    if (refPool !== undefined) {
      if (spec.parent) throw unsupported('a pool reference with parent=', spec.name);
      Object.assign(registry, lazyPoolRefColumns(spec, refPool, registry, options.pools, seed));
      continue;
    }

    // A running total is the one construct that genuinely cannot be answered
    // from a row index: row 900,000,000 IS the sum of everything before it.
    // That is not a gap in the streaming builder, it is what "running" means —
    // so it is refused by name and the router hands the config to the in-memory
    // engine, the same road every other whole-column construct takes.
    if (spec.gen?.type === 'running') {
      throw new StreamUnsupportedError(
        `a running total ("${spec.name}") is the accumulation of every row before it, ` +
          'so it cannot be computed one row at a time; the in-memory engine handles it ' +
          '(run without a forced streaming engine)',
      );
    }

    // A network call is not a draw: it is neither reproducible from a row index
    // nor answerable synchronously, which is what a lazy per-row resolver needs.
    // Refused here rather than left to fall through, because the fall-through
    // reached the in-memory engine's synchronous guard and told a CLI user to
    // "use the CLI".
    if (spec.gen?.type === 'http') {
      throw new StreamUnsupportedError(
        `<gen type="http"> ("${spec.name}") is a network call, so it is neither ` +
          'reproducible nor answerable one row at a time; the in-memory engine handles it ' +
          '(run without a forced streaming engine)',
      );
    }

    if (spec.uniq) {
      // Same rule as the env-level groups above: only the exact engine can
      // rearrange a finished column.
      if (!exactUniq) throw unsupported('uniq (a whole-column rearrangement)', spec.name);
      Object.assign(registry, buildExactCompoundUniq(spec, count, seed));
      continue;
    }

    if (spec.conditional) {
      registry[spec.name] = buildConditionalSeq(
        spec.name,
        spec.conditional,
        count,
        seed,
        locale,
        now,
        options,
        registry,
      );
      continue;
    }

    if (spec.switchSpec) {
      registry[spec.name] = buildSwitchSeq(
        spec.name,
        spec.switchSpec,
        count,
        seed,
        locale,
        now,
        options,
        registry,
      );
      continue;
    }

    if (spec.compute) {
      // Pure derived value: resolve(i) evaluates the compute tree against the
      // registry at row `i` (captured by reference, fully populated by render
      // time — the same pattern as conditional/switch). No PRNG, so no domain.
      const computeNode = spec.compute.node;
      registry[spec.name] = lazy(spec.name, (i) =>
        evaluateCompute(computeNode, (fieldName) => {
          const seq = registry[fieldName];
          return seq ? sequenceValueAt(seq, i) : undefined;
        }),
      );
      continue;
    }

    const domain = domainOf(spec, count, parents);

    if (spec.mixSpec) {
      // NOTE: the `#switch` stream-id suffix is a stable historical PRNG key —
      // keep it verbatim so a `<mix>` produces byte-identical values to the old
      // `<switch>` it replaced. Renaming it would silently change output.
      const mix = buildMixSeq(
        `${spec.name}#switch`,
        spec.mixSpec,
        domain,
        seed,
        locale,
        now,
        options,
      );
      registry[spec.name] = mix.sequence;
      if (mix.flag) registry[mix.flag.name] = mix.flag.sequence;
      continue;
    }

    if (spec.items) {
      // Composed sequence: the body in declaration order, each part on a stream
      // of its own so the row stays a function of its index.
      const { sequence, fields: base } = buildComposedStream(
        spec.name,
        spec.items,
        (id, item) => build(id, item.gen, domain, seed, locale, now, options).sequence,
      );
      const fields = spec.distinctGroups
        ? applyDistinct(spec, base, seed, locale, now, options)
        : base;
      for (const [fieldName, seq] of fields) registry[`${spec.name}.${fieldName}`] = seq;
      if (composesOwnValue(spec.items)) registry[spec.name] = sequence;
      continue;
    }

    if (spec.gens) {
      const base = new Map<string, Sequence>();
      for (const field of spec.gens) {
        base.set(
          field.name,
          build(`${spec.name}.${field.name}`, field.gen, domain, seed, locale, now, options)
            .sequence,
        );
      }
      const fields = spec.distinctGroups
        ? applyDistinct(spec, base, seed, locale, now, options)
        : base;
      for (const [name, seq] of fields) registry[`${spec.name}.${name}`] = seq;
    } else if (spec.gen) {
      const {
        sequence,
        parentCapable,
        flag: builtFlag,
      } = build(spec.name, spec.gen, domain, seed, locale, now, options);
      registry[spec.name] = sequence;
      if (parentCapable) parents.set(spec.name, parentCapable);
      // A repeating gen builds its own label alongside the values; everything
      // else derives one separately.
      const flag =
        builtFlag ?? anomalyFlagSequence(spec.gen, seed, spec.name, domain, locale, now, options);
      if (flag) registry[flag.name] = flag.sequence;
    }
  }

  // Env-level `<distinct>`: after all members exist, wrap them with a per-row
  // repair so their values differ within a row (row-local, like in-sequence).
  for (const group of envGroups.distinct) {
    applyEnvDistinct(group, specByName, registry, seed, locale, now, options);
  }
  return registry;
}

/**
 * Conditional sequence: the FIRST branch whose `if` is truthy (or the fallback
 * branch with no `if`) produces the row's value; if none match, the value is
 * empty. Branch conditions are evaluated against the full registry at row `i`,
 * so they can read other sequences (e.g. `Gender.Male`). Each branch gen draws
 * over all rows; the condition just decides which branch's value is used. The
 * registry is captured by reference — fully populated by render time.
 */
function buildConditionalSeq(
  name: string,
  branches: readonly CondBranch[],
  count: number,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
  registry: SequenceRegistry,
): Sequence {
  const fullDomain: Domain = { size: count, popIndexAt: (i) => i };
  const built = branches.map((b, k) => ({
    cond: b.cond,
    seq: build(`${name}#if${String(k)}`, b.gen, fullDomain, seed, locale, now, options).sequence,
  }));
  return lazy(name, (i) => {
    for (const b of built) {
      if (b.cond === undefined || evaluateIf(b.cond, registry, i)) {
        return sequenceValueAt(b.seq, i);
      }
    }
    return undefined;
  });
}

/**
 * Switch sequence (streaming): look the subject sequence's per-row value up in
 * the entries' keys — the FIRST matching entry's value-producer resolves the
 * row; no match → the `<default>` producer, else empty. Each entry is a
 * seekable case resolver over the full domain, so lookups stay O(1). The
 * subject is read from the registry lazily (populated by resolve time).
 */
function buildSwitchSeq(
  name: string,
  switchSpec: SwitchSpec,
  count: number,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
  registry: SequenceRegistry,
): Sequence {
  const fullDomain: Domain = { size: count, popIndexAt: (i) => i };
  const built = switchSpec.entries.map((e, k) => ({
    keys: e.keys,
    resolve: buildCaseResolver(
      e.value,
      `${name}#sw${String(k)}`,
      fullDomain,
      seed,
      locale,
      now,
      options,
    ),
  }));
  const fallback = switchSpec.fallback
    ? buildCaseResolver(
        switchSpec.fallback,
        `${name}#swdef`,
        fullDomain,
        seed,
        locale,
        now,
        options,
      )
    : undefined;
  return lazy(name, (i) => {
    const subject = registry[switchSpec.on];
    const key = subject ? (sequenceValueAt(subject, i) ?? '') : '';
    for (const e of built) {
      if (e.keys.includes(key)) return e.resolve(i);
    }
    return fallback ? fallback(i) : undefined;
  });
}

/** A feature the streaming builder can't do lazily — Engine 3 catches this to fall back. */
export class StreamUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamUnsupportedError';
  }
}

function unsupported(feature: string, name: string): StreamUnsupportedError {
  return new StreamUnsupportedError(
    `stream mode: ${feature} ("${name}") is not supported yet — ` +
      'run without mode="stream" (the in-memory engine handles it), or remove it.',
  );
}

/** Resolve a sequence's population domain: whole set, or a parent-value subset. */
function domainOf(spec: SequenceSpec, count: number, parents: Map<string, ParentCapable>): Domain {
  if (!spec.parent) return { size: count, popIndexAt: (i) => i };

  const dot = spec.parent.indexOf('.');
  const parentName = dot < 0 ? spec.parent : spec.parent.slice(0, dot);
  const parentValue = dot < 0 ? undefined : spec.parent.slice(dot + 1);
  if (parentValue === undefined || parentValue.length === 0) {
    throw unsupported(`bare parent="${spec.parent}" (use parent="Name.Value")`, spec.name);
  }
  const parent = parents.get(parentName);
  if (!parent) {
    throw unsupported(
      `parent "${parentName}" (the parent must be a finite-value <sequence> declared earlier)`,
      spec.name,
    );
  }
  if (!parent.hasValue(parentValue)) {
    throw new Error(
      `stream mode: sequence "${spec.name}" filters on parent value ` +
        `"${parentName}.${parentValue}", which the parent never produces.`,
    );
  }
  return {
    size: parent.quotaOf(parentValue),
    popIndexAt: (i) => parent.childRankAt(i, parentValue),
  };
}

/**
 * A seekable per-row `missing`/`anomaly` modifier, or null if the gen sets
 * neither. The inline-built types (counters, timeseries, pattern, text) don't
 * route through `buildGenValues`, so they apply this to match the in-memory
 * engine. Each modifier draws one uniform on its OWN dedicated seekable stream
 * — deterministic, seekable, and independent of value generation.
 */
function missingAnomalyMod(
  gen: GenSpec,
  seed: string,
  streamId: string,
  elementDraws = 1,
): ((i: number, v: string | undefined, k?: number) => string | undefined) | null {
  const anomaly = parseAnomaly(gen.attrs);
  const missing = parseMissing(gen.attrs);
  const hasAnomaly = anomaly !== undefined && anomaly.p > 0;
  const hasMissing = missing !== undefined && missing.p > 0;
  const fmt = genFormatter(gen.attrs['mask'], gen.attrs['case']);
  if (!hasAnomaly && !hasMissing && !fmt) return null;

  // With `repeat` a row needs one draw PER ELEMENT, so the whole row's draws
  // are pulled at once and indexed by `k`. Elements of a row arrive
  // consecutively, so a one-entry memo makes that a single pull per row rather
  // than one per element. `elementDraws = 1` reproduces the pre-repeat stream
  // exactly: seekableUniforms pulls sequentially, so [0] never depends on how
  // many were asked for.
  let cachedRow = -1;
  let anomDraws: number[] = [];
  let missDraws: number[] = [];
  const drawsFor = (i: number): void => {
    if (cachedRow === i) return;
    cachedRow = i;
    anomDraws = hasAnomaly ? seekableUniforms(seed, `${streamId}#anom`, i, elementDraws) : [];
    missDraws = hasMissing ? seekableUniforms(seed, `${streamId}#miss`, i, elementDraws) : [];
  };

  return (i, v, k = 0) => {
    if (v === undefined) return undefined; // an inactive row stays inactive
    drawsFor(i);
    let out = v;
    if (anomaly && hasAnomaly && (anomDraws[k] ?? 1) < anomaly.p) {
      const n = Number(out);
      if (Number.isFinite(n)) out = String(n * anomaly.factor);
    }
    if (missing && hasMissing && (missDraws[k] ?? 1) < missing.p) {
      out = missing.token;
    }
    return fmt ? fmt(out) : out;
  };
}

/**
 * Build the `anomaly_flag="NAME"` companion column for a streaming simple gen, or
 * null when there is no flag. It mirrors HOW `build()` applies anomaly so the flag
 * agrees with the value on every row: inline types use the seekable `#anom` draw
 * (same as `missingAnomalyMod`); independent types re-run the per-row build via
 * `resolveGenAnomalyFlagAt`. Parent-filtered rows are `undefined`.
 */
function anomalyFlagSequence(
  gen: GenSpec,
  seed: string,
  streamId: string,
  domain: Domain,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): { name: string; sequence: Sequence } | null {
  const name = gen.attrs['anomaly_flag'];
  if (name === undefined || name.trim() === '') return null;
  const anomaly = parseAnomaly(gen.attrs);
  if (!anomaly) return null;
  const { popIndexAt } = domain;
  const p = anomaly.p;
  // Independent gens resolve the label as TEXT, because with `repeat` it is a
  // LIST parallel to the value list — a single boolean could not say which
  // element of the batch spiked. Inline types never carry `repeat` (the
  // validator refuses it), so their single draw stays a plain boolean.
  const decide = INLINE_ANOMALY_TYPES.has(gen.type)
    ? (i: number): string =>
        (seekableUniforms(seed, `${streamId}#anom`, i, 1)[0] ?? 1) < p ? 'true' : 'false'
    : (i: number): string =>
        resolveGenAnomalyFlagTextAt(gen, i, seed, streamId, locale, now, options);
  const sequence = lazy(name, (i) => (popIndexAt(i) === undefined ? undefined : decide(i)));
  return { name, sequence };
}

export function build(
  streamId: string,
  gen: GenSpec,
  domain: Domain,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): {
  sequence: Sequence;
  parentCapable?: ParentCapable;
  flag?: { name: string; sequence: Sequence };
} {
  const { size, popIndexAt } = domain;

  // advanced_regex weighted choice `(?%{…})` hits its exact percentages only
  // over the whole column (Hamilton over `count`); a per-row draw would collapse
  // every row into the top branch. Like percent-weighted uniq, it can't be done
  // lazily — refuse it so disk mode routes such configs to the exact engine (and
  // Engine 3's seekable stage falls back to the in-memory engine).
  if (gen.type === 'advanced_regex' && advancedRegexHasWeightedChoice(gen.attrs['value'] ?? '')) {
    throw unsupported('advanced_regex weighted choice "(?%{…})"', streamId);
  }

  // Empty subset (a parent value with zero quota): always inactive.
  if (size === 0) return { sequence: lazy(streamId, () => undefined) };

  // `missing`/`anomaly` for the inline-built types below (counters, timeseries,
  // pattern, text). The `else` branch reaches them via resolveGenValueAt →
  // buildGenValues, so it must NOT be wrapped again.
  // A weighted file takes the SAME exact-quota road as `text`: proportions from
  // the data instead of from the config, honoured exactly rather than sampled.
  const weightColumn = gen.type === 'file' ? weightColumnOf(gen.attrs) : undefined;
  // `weight=` + `row=` on a file gen: the shared row must be drawn to a weighted
  // quota, which needs the whole file — the lazy per-card path can't. Defer to the
  // in-memory engine (the default auto-routes there; a forced streaming engine is
  // told, rather than silently producing incoherent columns).
  if (weightColumn !== undefined && (gen.attrs['row'] ?? '').trim() !== '') {
    throw new StreamUnsupportedError(
      `weight= combined with row= needs an exact quota over the whole file; ` +
        `the in-memory engine handles it (run without a forced streaming engine)`,
    );
  }
  // A WEIGHTED template pack takes the same exact-quota road: the streaming
  // engine resolves one row at a time, so — exactly like weighted text and the
  // length-group split — the quota must be planned over the whole column and
  // the row mapped into it by index, never decided from a single-cell draw.
  const weightedPack = weightedTemplatePack(gen, options.packs, locale);
  const genRepeat = parseRepeat(gen.attrs);
  const mod = missingAnomalyMod(gen, seed, streamId, genRepeat?.max ?? 1);

  // Lengths are an exact quota decided before any value exists, so the row's
  // slice of the slot space follows from its own position — never from a
  // running total over its predecessors, which is what would break `--jobs`.
  const repeatPlan = genRepeat
    ? planRepeat(
        genRepeat,
        size,
        computeCountsPerValue(
          size,
          repeatLengthPercents(genRepeat),
          createPrng(`${seed}|${streamId}|replen`),
        ),
      )
    : undefined;
  const repeatKey = permuteKey(seed, `${streamId}#replen`);
  /** The row's position in the length plan, or undefined when it is filtered out. */
  const repeatPosAt = (i: number): number | undefined => {
    const r = popIndexAt(i);
    return r === undefined ? undefined : permute(r, size, repeatKey);
  };
  const wrapLazy = (resolve: (i: number) => string | undefined): Sequence =>
    lazy(streamId, mod ? (i) => mod(i, resolve(i)) : resolve);

  // order="sequential": row i → the (population index mod N)-th list/file value,
  // in order (looping). Index-based, so it resolves seekably like the counters.
  if (
    (gen.type === 'text' || gen.type === 'file') &&
    gen.attrs['order'] === 'sequential' &&
    weightColumn === undefined
  ) {
    const list = sequentialList(gen, options.dataSources ?? {});
    const cycle = gen.attrs['cycle'] !== 'false';
    return {
      sequence: wrapLazy((i) => {
        const r = popIndexAt(i);
        return r === undefined ? undefined : pickSequential(list, r, cycle);
      }),
    };
  }

  // Row-linked file field (`row="K"`): every field sharing the key must resolve
  // the SAME CSV row for a given card (column coherence), while the row varies
  // per card. Engine 1 builds a shared plan of `count` indexes for this; the
  // streaming path can't materialize that (it resolves one card at a time), so
  // it re-derives the card's row index from a seekable stream keyed by the LINK
  // — shared across the link's fields, independent of each field's own stream.
  // `wrapLazy` still applies this field's own `missing`/`anomaly`/format.
  if (gen.type === 'file' && weightColumn === undefined) {
    const linked = prepareRowLinkedFileSource(gen, options.dataSources ?? {});
    if (linked) {
      return {
        sequence: wrapLazy((i) => {
          const r = popIndexAt(i);
          if (r === undefined) return undefined;
          const index = seekableInt(seed, linked.streamId, i, linked.rowCount);
          return csvColumnCell(linked.rows[index] ?? [], linked.columnIndex);
        }),
      };
    }
  }

  if (gen.type === 'increment' || gen.type === 'decrement') {
    const start = gen.attrs['value'] === undefined ? 0 : Number(gen.attrs['value']);
    const step = gen.attrs['step'] === undefined ? 1 : Number(gen.attrs['step']);
    const kind = gen.type;
    return {
      sequence: wrapLazy((i) => {
        const r = popIndexAt(i);
        return r === undefined ? undefined : String(counterValueAt(kind, start, step, r));
      }),
    };
  }

  if (gen.type === 'timeseries') {
    // Index-dependent, like counters: value uses the (population) row index; the
    // noise draw is seekable per row on a dedicated stream.
    const spec = parseTimeseries(gen.attrs);
    const noisy = timeseriesHasNoise(spec);
    return {
      sequence: wrapLazy((i) => {
        const r = popIndexAt(i);
        if (r === undefined) return undefined;
        let z = 0;
        if (noisy) {
          const [u1 = 0.5, u2 = 0.5] = seekableUniforms(seed, `${streamId}:ts`, i, 2);
          z = standardNormal(u1, u2);
        }
        return formatTimeseries(timeseriesValueAt(spec, r, z), spec.decimals);
      }),
    };
  }

  if (gen.type === 'pattern') {
    // The drawn curve(s) stretched across the rows: card r of `size` reads at
    // t = r/(size−1). Signal = deterministic; corridor draws one seekable uniform
    // per card for the random value in the band. Index-dependent → special-cased.
    const pg = patternGenForGen(gen, options.dataSources ?? {});
    const draws = patternGenDraws(pg);
    const denom = size > 1 ? size - 1 : 1;
    return {
      sequence: wrapLazy((i) => {
        const r = popIndexAt(i);
        if (r === undefined) return undefined;
        const u = draws ? (seekableUniforms(seed, `${streamId}:pat`, i, 1)[0] ?? 0.5) : 0;
        return patternGenValue(pg, r / denom, u, 1 / denom);
      }),
    };
  }

  if (gen.type === 'text' || weightColumn !== undefined || weightedPack !== undefined) {
    const weighted =
      weightColumn === undefined
        ? weightedPack
        : loadWeightedValues(
            resolveExistingDataSourcePath(gen.attrs['src'] ?? '', options.dataSources ?? {}).path,
            {
              column: gen.attrs['column'],
              header: gen.attrs['header'],
              delimiter: gen.attrs['delimiter'],
            },
            weightColumn,
          );
    const values = weighted
      ? weighted.values
      : (gen.attrs['value'] ?? '').split(',').map((s) => s.trim());
    const percentAttr = gen.attrs['percent'];
    const percents = weighted
      ? weighted.percents
      : percentAttr !== undefined && percentAttr.length > 0
        ? expandPercentMask(percentAttr, values.length)
        : values.map(() => 100 / values.length);
    // With `repeat` a row occupies `max` slots instead of one, so the exact
    // quota is planned over ELEMENTS. When nothing is discarded (a fixed
    // repeat, or none at all) the percentages stay exact; a variable repeat
    // throws slots away, which downgrades them to approximate — the validator
    // says so rather than letting it pass silently.
    const slotCount = repeatPlan ? repeatPlan.totalSlots : size;
    const counts = computeCountsPerValue(
      slotCount,
      percents,
      createPrng(`${seed}|${streamId}|pct`),
    );
    const key = permuteKey(seed, streamId);
    const cumLo: number[] = []; // value v owns slots [cumLo[v], cumHi[v])
    const cumHi: number[] = [];
    let acc = 0;
    for (const c of counts) {
      cumLo.push(acc);
      acc += c;
      cumHi.push(acc);
    }
    const slotAt = (i: number, k = 0): number | undefined => {
      if (!repeatPlan) {
        const pi = popIndexAt(i);
        return pi === undefined ? undefined : permute(pi, slotCount, key);
      }
      const p = repeatPosAt(i);
      return p === undefined ? undefined : permute(repeatPlan.slotStartAt(p) + k, slotCount, key);
    };
    // Binary search the cumulative bounds — O(log #values), not a linear scan;
    // matters for WIDE columns (many values) so a render stays O(count·log).
    const n = values.length;
    const valueForSlot = (slot: number): string => {
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (slot < (cumHi[mid] ?? 0)) hi = mid;
        else lo = mid + 1;
      }
      return values[lo] ?? '';
    };
    const sequence = genRepeat
      ? lazy(streamId, (i) => {
          const p = repeatPosAt(i);
          if (p === undefined || !repeatPlan) return undefined;
          const keep = repeatPlan.lengthAt(p);
          const parts: string[] = [];
          for (let k = 0; k < keep; k++) {
            const slot = slotAt(i, k);
            const raw = slot === undefined ? '' : valueForSlot(slot);
            parts.push((mod ? mod(i, raw, k) : raw) ?? '');
          }
          return joinParts(parts, genRepeat);
        })
      : wrapLazy((i) => {
          const slot = slotAt(i);
          return slot === undefined ? undefined : valueForSlot(slot);
        });
    // A repeating text column holds a LIST ("a,b,c"), so `parent="Name.value"`
    // has nothing coherent to match against — do not advertise it as a parent.
    const parentCapable: ParentCapable = {
      hasValue: (v) => !genRepeat && values.includes(v),
      quotaOf: (v) => counts[values.indexOf(v)] ?? 0,
      childRankAt: (i, v) => {
        const slot = slotAt(i);
        const vi = values.indexOf(v);
        if (slot === undefined || vi < 0) return undefined;
        const lo = cumLo[vi] ?? 0;
        const quota = counts[vi] ?? 0;
        return slot >= lo && slot < lo + quota ? slot - lo : undefined;
      },
    };
    return { sequence, parentCapable };
  }

  // `length="2,10-12" percent="85,15"`: which LENGTH GROUP a row gets is an
  // exact quota over the whole column, so it cannot be decided from the row's
  // own draw. The generic path below hands the builder count=1, and a Hamilton
  // quota over a single cell always awards it to the largest share — which came
  // out as winner-take-all (1000/0 instead of 850/150) rather than as a skew.
  //
  // Same shape as the weighted `text` path above: plan the counts once, map the
  // row's population index to a slot through the permutation, and look the group
  // up by cumulative bounds. Then hand the per-row builder a spec pinned to that
  // one group, so the digits still come from the row's own seekable draw.
  const lengthChoices = numberLengthChoicesOf(gen);
  if (lengthChoices && lengthChoices.length > 1) {
    const percents = expandPercentMask(gen.attrs['percent'] ?? '', lengthChoices.length);
    const counts = computeCountsPerValue(size, percents, createPrng(`${seed}|${streamId}|lenpct`));
    const key = permuteKey(seed, `${streamId}#lenpct`);
    const cumHi: number[] = [];
    let acc = 0;
    for (const c of counts) {
      acc += c;
      cumHi.push(acc);
    }
    const groupForSlot = (slot: number): NumberLengthChoice | undefined => {
      let lo = 0;
      let hi = lengthChoices.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (slot < (cumHi[mid] ?? 0)) hi = mid;
        else lo = mid + 1;
      }
      return lengthChoices[lo];
    };
    return {
      sequence: wrapLazy((i) => {
        const r = popIndexAt(i);
        if (r === undefined) return undefined;
        const group = groupForSlot(permute(r, size, key));
        if (!group) return undefined;
        return resolveGenValueAt(pinLength(gen, group), i, seed, streamId, locale, now, options);
      }),
    };
  }

  // Independent generator: draw per active row, reusing the existing generator.
  if (genRepeat && repeatPlan) {
    // Each element gets its own seekable sub-stream, so the row still resolves
    // alone. `repeat` is stripped from the spec handed down — otherwise the
    // per-row builder would apply it a second time.
    const single = withoutRepeat(gen);
    const perElement = <T>(i: number, read: (k: number) => T): T[] | undefined => {
      const p = repeatPosAt(i);
      if (p === undefined) return undefined;
      const out: T[] = [];
      for (let k = 0; k < repeatPlan.lengthAt(p); k++) out.push(read(k));
      return out;
    };
    const flagName = gen.attrs['anomaly_flag'];
    const sequence = lazy(streamId, (i) =>
      joinPartsOpt(
        perElement(i, (k) =>
          resolveGenValueAt(single, i, seed, `${streamId}#e${String(k)}`, locale, now, options),
        ),
        genRepeat,
      ),
    );
    if (flagName === undefined || flagName.trim() === '' || !parseAnomaly(gen.attrs)) {
      return { sequence };
    }
    // Same loop, same sub-stream ids as the values above — so element k's label
    // describes element k's value and nothing else.
    return {
      sequence,
      flag: {
        name: flagName,
        // The flag list is a parallel list of true/false, never a running total —
        // accumulating it would be meaningless — so it joins with the separator
        // alone rather than through joinParts.
        sequence: lazy(flagName, (i) =>
          perElement(i, (k) =>
            resolveGenAnomalyFlagTextAt(
              single,
              i,
              seed,
              `${streamId}#e${String(k)}`,
              locale,
              now,
              options,
            ),
          )?.join(genRepeat.separator),
        ),
      },
    };
  }
  return {
    sequence: lazy(streamId, (i) => {
      const r = popIndexAt(i);
      return r === undefined
        ? undefined
        : resolveGenValueAt(gen, i, seed, streamId, locale, now, options);
    }),
  };
}

/** Assemble one `<case>`'s parts (data / gen / nested mix) into a value(i). */
export function buildCaseResolver(
  caseSpec: CaseSpec,
  streamId: string,
  caseDomain: Domain,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): (i: number) => string {
  const partResolvers = caseSpec.parts.map((part, p): ((i: number) => string) => {
    if (part.kind === 'data') {
      const text = part.text;
      return () => text;
    }
    // Both a gen and a nested mix resolve over the case's SUBSET domain, so
    // counters count within the case, text is exact-% within it, and nested
    // switches split within it — reusing the same builders as top-level.
    const sub =
      part.kind === 'gen'
        ? build(`${streamId}#p${String(p)}`, part.gen, caseDomain, seed, locale, now, options)
            .sequence
        : // A nested mix contributes only its value; `flag=` is a top-level
          // sequence-name concern, so any flag on an inner mix is ignored here
          // (the validator rejects it).
          buildMixSeq(
            `${streamId}#p${String(p)}`,
            part.mixSpec,
            caseDomain,
            seed,
            locale,
            now,
            options,
          ).sequence;
    return (i) => sequenceValueAt(sub, i) ?? '';
  });
  return (i) => partResolvers.map((r) => r(i)).join('');
}

/**
 * In-sequence `<distinct>`: within a row, the fields of a group must all differ.
 * Row-local — no cross-row coordination — so it's a per-row repair over the
 * base resolvers. For each group (declaration order), a field whose value
 * collides with an already-accepted one in the group is redrawn from its own
 * gen (a fresh per-row seekable draw with a bumped key) until it differs.
 * Ungrouped fields keep their base resolver. A shared 1-row memo means the
 * repair runs once per row even though each field reads through it.
 */
function applyDistinct(
  spec: SequenceSpec,
  base: Map<string, Sequence>,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): Map<string, Sequence> {
  const groups = (spec.distinctGroups ?? [])
    .map((g) => g.filter((f) => base.has(f)))
    .filter((g) => g.length >= 2);
  if (groups.length === 0) return base;

  const genByField = new Map<string, GenSpec>();
  for (const f of spec.gens ?? []) genByField.set(f.name, f.gen);

  let cachedRow = -1;
  let cached = new Map<string, string | undefined>();
  const repairedRow = (i: number): Map<string, string | undefined> => {
    if (i === cachedRow) return cached;
    const values = new Map<string, string | undefined>();
    for (const [name, seq] of base) values.set(name, sequenceValueAt(seq, i));
    for (const group of groups) {
      const seen = new Set<string>();
      for (const fieldName of group) {
        let value = values.get(fieldName);
        if (value === undefined) continue; // inactive row (parent-filtered)
        let attempt = 0;
        while (seen.has(value)) {
          attempt += 1;
          if (attempt > DISTINCT_FUSE) throw distinctFuseError(spec.name, fieldName);
          const gen = genByField.get(fieldName);
          const key = `${spec.name}.${fieldName}#d${String(attempt)}`;
          value = gen ? resolveGenValueAt(gen, i, seed, key, locale, now, options) : value;
        }
        values.set(fieldName, value);
        seen.add(value);
      }
    }
    cachedRow = i;
    cached = values;
    return values;
  };

  const out = new Map(base);
  for (const fieldName of new Set(groups.flat())) {
    const id = `${spec.name}.${fieldName}`;
    out.set(
      fieldName,
      lazy(id, (i) => repairedRow(i).get(fieldName)),
    );
  }
  return out;
}

function distinctFuseError(seqName: string, fieldName: string): Error {
  return new Error(
    `stream mode: <distinct> in sequence "${seqName}": could not find a value for field ` +
      `"${fieldName}" different from the others after ${String(DISTINCT_FUSE)} attempts — ` +
      'its source likely has too few distinct values.',
  );
}

/**
 * Env-level `<distinct>`: the wrapped scalar sequences must differ from each
 * other within a row. Same per-row repair as in-sequence `<distinct>`, but the
 * "fields" are separate top-level sequences (already built). Members must be
 * simple sequences (a redraw needs a single gen); `<mix>` members stay on
 * the in-memory engine. Replaces each member's registry entry with a wrapped
 * resolver sharing one per-row memo.
 */
function applyEnvDistinct(
  group: readonly string[],
  specByName: Map<string, SequenceSpec>,
  registry: Record<string, Sequence>,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): void {
  const members = group.filter((name) => registry[name] !== undefined && specByName.has(name));
  if (members.length < 2) return;

  const base = new Map<string, Sequence>();
  const genByName = new Map<string, GenSpec>();
  for (const name of members) {
    const spec = specByName.get(name);
    if (spec?.mixSpec) throw unsupported(`<distinct> member "${name}" is a <mix>`, name);
    if (spec?.switchSpec) throw unsupported(`<distinct> member "${name}" is a <switch>`, name);
    if (!spec?.gen)
      throw unsupported(`<distinct> member "${name}" (must be a simple sequence)`, name);
    const seq = registry[name];
    if (seq) base.set(name, seq);
    genByName.set(name, spec.gen);
  }

  let cachedRow = -1;
  let cached = new Map<string, string | undefined>();
  const repairedRow = (i: number): Map<string, string | undefined> => {
    if (i === cachedRow) return cached;
    const values = new Map<string, string | undefined>();
    for (const name of members) {
      const b = base.get(name);
      values.set(name, b ? sequenceValueAt(b, i) : undefined);
    }
    const seen = new Set<string>();
    for (const name of members) {
      let value = values.get(name);
      if (value === undefined) continue; // inactive (parent-filtered) row
      let attempt = 0;
      while (seen.has(value)) {
        attempt += 1;
        if (attempt > DISTINCT_FUSE) throw envDistinctFuseError(name);
        const gen = genByName.get(name);
        const key = `${name}#ed${String(attempt)}`;
        value = gen ? resolveGenValueAt(gen, i, seed, key, locale, now, options) : value;
      }
      values.set(name, value);
      seen.add(value);
    }
    cachedRow = i;
    cached = values;
    return values;
  };

  for (const name of members) {
    registry[name] = lazy(name, (i) => repairedRow(i).get(name));
  }
}

function envDistinctFuseError(name: string): Error {
  return new Error(
    `stream mode: <distinct> across sequences: could not find a value for sequence ` +
      `"${name}" different from the others after ${String(DISTINCT_FUSE)} attempts — ` +
      'its source likely has too few distinct values.',
  );
}

/** Distinct values in first-seen order (dedup keeps the mixed-radix a bijection). */
function distinctValues(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Engine 3 compound `uniq="true"`: keep each field's EXACT percentages and
 * verify the tuples are unique (arrangeExactUniq). Parented / non-text uniq
 * still throws `unsupported` → the caller falls back to the in-memory engine.
 */
function buildExactCompoundUniq(
  spec: SequenceSpec,
  count: number,
  seed: string,
): Record<string, Sequence> {
  // A simple uniq draws WITHOUT REPLACEMENT over the whole column — state the
  // streaming engines cannot hold row by row. The router sends auto/disk mode
  // to the in-memory engine; this refusal is the backstop for a forced one.
  if (!spec.gens) throw unsupported('uniq on a simple sequence (a whole-column draw)', spec.name);
  if (spec.parent) throw unsupported('uniq combined with a parent', spec.name);

  const fields: ExactUniqField[] = spec.gens.map((f) => {
    if (f.gen.type !== 'text') {
      throw unsupported(
        `uniq field "${f.name}" of type "${f.gen.type}" (only text lists)`,
        spec.name,
      );
    }
    const values = distinctValues((f.gen.attrs['value'] ?? '').split(',').map((s) => s.trim()));
    if (values.length === 0) {
      throw unsupported(`uniq field "${f.name}" with an empty value list`, spec.name);
    }
    const percentAttr = f.gen.attrs['percent'];
    const percents =
      percentAttr !== undefined && percentAttr.length > 0
        ? expandPercentMask(percentAttr, values.length)
        : values.map(() => 100 / values.length);
    return { id: `${spec.name}.${f.name}`, values, percents };
  });
  return arrangeExactUniq(fields, count, seed, `"${spec.name}"`);
}
