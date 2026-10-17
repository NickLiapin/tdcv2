/**
 * Which engine runs a config, and why.
 *
 * The router behind `mode="disk"` — the default — and the reason it gives for
 * its choice, which `check` prints and a run repeats when an engine asked for by
 * name hands the config to another. Kept apart from the renderer that consults
 * it: the reasons are read by people, and the rules are the part every
 * implementation has to agree on.
 */

import { advancedRegexHasWeightedChoice } from '../generators/advanced-regex.js';
import type { CaseSpec, SequenceSpec, SwitchSpec } from '../sequence/index.js';
import { isDynamicTemplateValue } from '../validator/known.js';

import type { AttrMap } from './attrs.js';
import type { EngineId, EngineSelection } from './render.js';

/**
 * The engine a run uses, and why — for `check`, and for the note a run prints
 * when an engine asked for by name hands the config to another.
 */
export interface EngineChoice {
  readonly engine: EngineId;
  readonly why: string;
  /** Engine 3 was asked for and engine 1 runs the config instead. */
  readonly downgraded?: boolean;
}

/** How each engine is named next to its number. */
export const ENGINE_LABELS: Readonly<Record<EngineId, string>> = {
  1: 'in memory',
  2: 'streaming',
  3: 'exact, on disk',
};

/** Resolve a selection to a concrete engine, routing `disk` mode by config. */
export function resolveRenderEngine(
  selection: EngineSelection,
  specs: readonly SequenceSpec[],
  envUniqGroups: readonly (readonly string[])[],
): EngineId {
  return explainRenderEngine(selection, specs, envUniqGroups).engine;
}

/**
 * The engine a selection resolves to, and the reason in words.
 *
 * Engine 3 asked for by name runs a config the disk route sends to engine 1 on
 * engine 1, and says so. It always did that, silently, at the last moment — the
 * lazy build refused and the in-memory engine took over — which left nothing
 * for `check` to report and, past the row count where a run splits itself into
 * threads, handed each worker a refusal it had no way to take over from: three
 * of the five implementations exited 1 there. Deciding it here, before the run,
 * is the same answer every implementation can give.
 */
export function explainRenderEngine(
  selection: EngineSelection,
  specs: readonly SequenceSpec[],
  envUniqGroups: readonly (readonly string[])[],
): EngineChoice {
  if ('forced' in selection) {
    if (selection.forced === 3) {
      const disk = diskRoute(specs, envUniqGroups);
      if (disk.engine === 1) return { ...disk, downgraded: true };
    }
    return {
      engine: selection.forced,
      why: selection.why ?? `engine ${String(selection.forced)} was asked for`,
    };
  }
  if (selection.mode === 'memory') return { engine: 1, why: selection.why ?? 'mode="memory"' };
  return diskRoute(specs, envUniqGroups);
}

/** One line for `check`: the engine, its name, and the reason. */
export function describeEngineChoice(choice: EngineChoice): string {
  const engine = `engine ${String(choice.engine)} (${ENGINE_LABELS[choice.engine]})`;
  return choice.downgraded === true
    ? `runs on ${engine}, not engine 3: ${choice.why}`
    : `runs on ${engine}: ${choice.why}`;
}

/** `mode="disk"`, the default: the fastest engine the config allows, and why. */
function diskRoute(
  specs: readonly SequenceSpec[],
  envUniqGroups: readonly (readonly string[])[],
): EngineChoice {
  const memory = (why: string): EngineChoice => ({ engine: 1, why });
  // A template `value` that interpolates a field (`common.vehicle.model.${{Brand}}`)
  // resolves its address per row from the sibling registry — neither the lazy
  // (Engine 2) nor the on-disk (Engine 3) path can do that, only the in-memory
  // engine. Route disk mode there. (An explicitly forced engine above is honoured
  // and will error clearly if it can't resolve the address.)
  const dynamic = dynamicTemplateOwner(specs);
  if (dynamic !== undefined) return memory(`"${dynamic}" picks its pack per row`);
  // `weight=` + `row=` draws a linked CSV row to an exact weighted quota — the
  // in-memory engine does it; the streaming engines can't weight a per-card row
  // draw without the global total, so route it to Engine 1 too.
  const weightedRow = weightedRowLinkOwner(specs);
  if (weightedRow !== undefined) {
    return memory(`"${weightedRow}" draws a weighted row of a file (weight= with row=)`);
  }
  /*
   * A pack generator that declares a share used to be routed to Engine 1, and
   * for a real reason: resolved a row at a time the quota was computed over a
   * single row and every row went to the largest share, silently.
   *
   * The streaming builder plans such a body over the COLUMN now, so the reason
   * is gone — and keeping the routing rule after the refusal went was worse than
   * doing nothing, because the config still landed on the engine that holds the
   * whole table. Measured on a 5,000,000-row `hu.person.male.fullName` column:
   * Engine 1 wanted 2 GB and died under a 512 MB cap, while the streaming path
   * finished the same run inside 512 MB.
   *
   * One shape still belongs here: a body carrying its own `<valid>`, where
   * rejecting a row and redrawing it is a whole-column decision with no lazy
   * form. `wholeColumnPackBody` hands that one back unbuilt and the streaming
   * builder refuses it, which routes it here the way every other refusal does.
   */
  // `uniq="true"` on a simple sequence draws WITHOUT REPLACEMENT — the pool
  // and the taken-set span the whole column, which the streaming engines
  // cannot hold row by row. The in-memory engine does it.
  const simpleUniq = simpleUniqOwner(specs);
  if (simpleUniq !== undefined) return memory(`uniq="true" on "${simpleUniq}"`);
  // A `type="http"` generator makes a network call and is non-deterministic, so
  // it never runs on the reproducible streaming/on-disk path — it resolves in
  // the in-memory engine's async post-pass. Route disk mode to Engine 1. (Forced
  // engine="2"/"3" is honoured above and fails clearly in the streaming build,
  // which has no http case.)
  const http = genOwner(specs, (g) => g.type === 'http');
  if (http !== undefined) return memory(`"${http}" calls a web service`);
  // A `<switch>` branch that declares a share the streaming engines cannot lay
  // over the right rows. They REFUSE such a branch rather than apportion it over
  // the wrong denominator, and a refusal reached at build time is not a fallback
  // when the run is parallel: `--jobs` hands each worker a FORCED streaming
  // engine, which has nowhere to fall back to. Measured before this line
  // existed: a 200,000-row config with `<case is="US|CA|MX">` holding a
  // percentage produced a full file single-threaded and exited 1 with the
  // refusal under `--jobs 4`. Decide it here, statically, where both paths see
  // the same answer.
  const switchShare = unstreamableSwitchPercentOwner(specs);
  if (switchShare !== undefined) {
    return memory(`a share inside "${switchShare}" needs the whole column`);
  }
  // A column derived from another column — running, stat, a date offset, a
  // formula. The streaming builder refuses each by name; deciding it here is
  // what keeps that refusal from reaching a parallel worker, which has no
  // fallback. See `specsUseDerivedColumn` for what this cost before.
  const derived = derivedColumn(specs);
  if (derived !== undefined) return memory(derived);
  // `parent="Name"` with no value narrows a column to the rows where the parent
  // produced ANYTHING, which the streaming builder refuses because it cannot know
  // that without the parent's whole column. Same reason as the two lines above:
  // the refusal is only a fallback on the single-threaded path, and `--jobs`
  // hands each worker a FORCED streaming engine with nowhere to fall back to.
  // Measured before this line existed: the hierarchical-dependencies page's own
  // valueless-`parent` example wrote 99,999 rows and exited 0, then wrote a
  // ZERO-BYTE file and exited 1 at 100,000 — `AUTO_JOBS_MIN_ROWS`, the point
  // where the run parallelises itself. `check` called it valid at both sizes.
  const bare = bareParent(specs);
  if (bare !== undefined) return memory(bare);
  // disk mode: the fastest engine the config allows.
  const exact = exactEngineReason(specs, envUniqGroups);
  if (exact !== undefined) return { engine: 3, why: exact };
  return { engine: 2, why: 'every column can be built one row at a time' };
}

/** Does this `<case>` body declare a share that the denominator has to be right for? */
function caseCarriesPercent(body: CaseSpec | undefined): boolean {
  return (body?.parts ?? []).some(
    (part) =>
      (part.kind === 'mix' && (part.mixSpec.attrs['percent'] ?? '').trim() !== '') ||
      (part.kind === 'gen' && (part.gen.attrs['percent'] ?? '').trim() !== ''),
  );
}

/**
 * A `<switch>` branch whose share the streaming engines cannot honour.
 *
 * They can subset a branch keyed on ONE value of a plain values list — the same
 * bijection `parent="Gender.Male"` uses. They cannot rank a multi-key branch
 * (`US|CA|MX` is a union, and ranks across a union do not compose), nor
 * `<default>` (a complement, which nothing enumerates), nor any branch whose
 * subject is not a finite values list to begin with.
 *
 * Deliberately conservative: anything it cannot prove streamable goes to
 * Engine 1, which costs speed on an exotic config and never costs correctness.
 * The opposite mistake is the one that ends a run.
 */
function unstreamableSwitchPercentOwner(specs: readonly SequenceSpec[]): string | undefined {
  const plainListValues = (name: string): readonly string[] | undefined => {
    const subject = specs.find((s) => s.name === name);
    const gen = subject?.gen;
    if (gen?.type !== 'text') return undefined;
    if ((gen.attrs['order'] ?? '') === 'sequential') return undefined;
    if ((gen.attrs['repeat'] ?? '').trim() !== '') return undefined;
    return (gen.attrs['value'] ?? '').split(',').map((v) => v.trim());
  };

  const topLevelUnstreamable = (sw: SwitchSpec): boolean => {
    if (caseCarriesPercent(sw.fallback)) return true;
    const values = plainListValues(sw.on);
    return sw.entries.some((entry) => {
      if (!caseCarriesPercent(entry.value)) return false;
      const key = entry.keys.length === 1 ? entry.keys[0] : undefined;
      return key === undefined || !values?.includes(key);
    });
  };

  // A NESTED switch is never rankable — its branch covers an intersection of two
  // partitions, and there is no O(1) rank inside one. So any share it declares,
  // at any depth, decides Engine 1.
  const nestedUnstreamable = (sw: SwitchSpec): boolean =>
    caseCarriesPercent(sw.fallback) || sw.entries.some((e) => caseCarriesPercent(e.value));

  return specs.find((spec) => {
    const nested = [
      ...(spec.switchSpec
        ? [...spec.switchSpec.entries.map((e) => e.value), spec.switchSpec.fallback]
        : []),
      ...(spec.mixSpec?.cases ?? []),
    ].flatMap((body) => nestedSwitches(body));
    if (nested.some(nestedUnstreamable)) return true;
    return spec.switchSpec !== undefined && topLevelUnstreamable(spec.switchSpec);
  })?.name;
}

/** Every `<switch>` written inside this `<case>` body, at any depth. */
function nestedSwitches(body: CaseSpec | undefined): SwitchSpec[] {
  const found: SwitchSpec[] = [];
  const visit = (c: CaseSpec | undefined): void => {
    for (const part of c?.parts ?? []) {
      if (part.kind === 'switch') {
        found.push(part.switchSpec);
        for (const entry of part.switchSpec.entries) visit(entry.value);
        visit(part.switchSpec.fallback);
      } else if (part.kind === 'mix') {
        for (const inner of part.mixSpec.cases) visit(inner);
      }
    }
  };
  visit(body);
  return found;
}

/** Any `<gen type="http">` — the network-backed generator. */
export function specsUseHttp(specs: readonly SequenceSpec[]): boolean {
  return anyGen(specs, (g) => g.type === 'http');
}

/**
 * True if any sequence is a column DERIVED from another column.
 *
 * `running`, `stat` and a date offset are built in declaration order out of
 * columns that already exist, and the streaming builder refuses each by name.
 *
 * `formula` is NOT in this list, and the difference is the whole point: it reads
 * only its OWN row, so it streams — see the formula case in `stream-build.ts`.
 * `running` needs every row before this one and `stat` needs every row at all,
 * which is not a gap in the streaming builder but what those two constructs
 * mean. A date offset needs only its own row too and could join `formula` once
 * its instant-column bookkeeping is taught to resolve lazily. Before this existed the refusal was left to the build,
 * which worked single-threaded — the auto-routed disk mode caught it and fell
 * back to the in-memory engine — and then died above the row count where the
 * run goes parallel, because each worker gets a FORCED streaming engine with
 * nowhere to fall back to. The message it printed was the worst part: "run
 * without a forced streaming engine", to a user who had forced nothing.
 *
 * Measured on 0.2.1, before this line: a 200,000-row config with `running`,
 * with `stat`, with `<gen type="date" of=…>`, and with `formula` all produced a
 * full file at 5,000 rows and exited 1 at 200,000. Three of those four are
 * SHIPPED features.
 *
 * So the decision moves here, where it is static and both paths see the same
 * answer — exactly the reasoning `specsUseUnstreamableSwitchPercent` already
 * carries, applied to the case it did not cover.
 */
export function specsUseDerivedColumn(specs: readonly SequenceSpec[]): boolean {
  return derivedColumn(specs) !== undefined;
}

/** The first column derived from other rows, said in words; undefined when none is. */
function derivedColumn(specs: readonly SequenceSpec[]): string | undefined {
  const running = genOwner(specs, (g) => g.type === 'running');
  if (running !== undefined) return `"${running}" adds up the rows before it`;
  const stat = genOwner(specs, (g) => g.type === 'stat');
  if (stat !== undefined) return `"${stat}" is computed over every row`;
  const offset = genOwner(specs, (g) => g.type === 'date' && (g.attrs['of'] ?? '').trim() !== '');
  if (offset !== undefined) return `"${offset}" is a date offset from another column`;
  return undefined;
}

/**
 * Any sequence whose `parent=` names a sequence but not one of its VALUES.
 *
 * `parent="Country.US"` is a filter the streaming engines can evaluate a row at a
 * time: the row either drew `US` or it did not. `parent="Country"` asks a different
 * question — "the rows where Country produced anything at all" — and answering it
 * needs the parent's finished column, which is exactly what streaming does not have.
 * The condition is kept identical to `domainOf` in `sequence/stream-build.ts`, which
 * is the code that would otherwise refuse it mid-run.
 */
export function specsUseBareParent(specs: readonly SequenceSpec[]): boolean {
  return bareParent(specs) !== undefined;
}

/** The first such sequence, said in words; undefined when there is none. */
function bareParent(specs: readonly SequenceSpec[]): string | undefined {
  const child = specs.find((s) => {
    const parent = (s.parent ?? '').trim();
    if (parent === '') return false;
    const dot = parent.indexOf('.');
    return dot < 0 || parent.slice(dot + 1).length === 0;
  });
  return child === undefined
    ? undefined
    : `"${child.name}" has parent="${(child.parent ?? '').trim()}" with no value`;
}

/** True if any `<gen>` in `specs` (simple or compound field) satisfies `pred`. */
function anyGen(
  specs: readonly SequenceSpec[],
  pred: (gen: { readonly type: string; readonly attrs: AttrMap }) => boolean,
): boolean {
  return genOwner(specs, pred) !== undefined;
}

/** The name of the first sequence holding a `<gen>` (simple or compound field) that satisfies `pred`. */
function genOwner(
  specs: readonly SequenceSpec[],
  pred: (gen: { readonly type: string; readonly attrs: AttrMap }) => boolean,
): string | undefined {
  const check = (gen: { readonly type: string; readonly attrs: AttrMap } | undefined): boolean =>
    gen !== undefined && pred(gen);
  return specs.find((s) => check(s.gen) || (s.gens ?? []).some((f) => check(f.gen)))?.name;
}

/** Any simple `<gen type="template">` whose `value` interpolates a field. */
function dynamicTemplateOwner(specs: readonly SequenceSpec[]): string | undefined {
  return genOwner(
    specs,
    (g) => g.type === 'template' && isDynamicTemplateValue(g.attrs['value'] ?? ''),
  );
}

/**
 * Any sequence carrying `uniq="true"` whose value is DRAWN — a whole-column draw.
 *
 * Both the simple shape (one anonymous `<gen>`) and the composed one (a drawn
 * part plus constants) take from a pool without replacement, and the pool and
 * the taken-set span the whole column. Missing the composed shape is what sent
 * such a config to a streaming engine, where one implementation crashed, one
 * refused and three ignored the attribute in silence.
 */
function simpleUniqOwner(specs: readonly SequenceSpec[]): string | undefined {
  const counting = (type: string): boolean => type === 'increment' || type === 'decrement';
  return specs.find((s) => {
    if (s.uniq !== true) return false;
    if (s.gen !== undefined) return !counting(s.gen.type);
    return (s.items ?? []).some((i) => i.kind === 'gen' && !counting(i.gen.type));
  })?.name;
}

/** Any `<gen type="file">` that combines `weight=` and `row=`. */
function weightedRowLinkOwner(specs: readonly SequenceSpec[]): string | undefined {
  return genOwner(
    specs,
    (g) =>
      g.type === 'file' &&
      (g.attrs['weight'] ?? '').trim() !== '' &&
      (g.attrs['row'] ?? '').trim() !== '',
  );
}

/**
 * True if the config needs Engine 3 rather than Engine 2 for disk mode — i.e.
 * it uses something Engine 2 can't do lazily: ANY `uniq`, a parent-child whose
 * parent isn't a finite text sequence, or an `advanced_regex` weighted choice
 * `(?%{…})` (exact percentages need the whole column). Everything else (exact
 * %, switch, distinct, text parent-child) streams fine on Engine 2.
 *
 * `uniq` is here in full, and that is a deliberate cost. A group REARRANGES the
 * columns it covers — every column keeps its multiset, so every declared share
 * survives — and that cannot be decided a row at a time. Engine 2 could only
 * offer a different answer: a mixed-radix bijection over the whole combination
 * space, which is uniform over combinations and discards the values actually
 * drawn. Two engines, two datasets from one seed. Sending uniq to Engine 3
 * costs a uniq config the lazy path and buys back one answer everywhere.
 */
export function needsExactEngine(
  specs: readonly SequenceSpec[],
  envUniqGroups: readonly (readonly string[])[],
): boolean {
  return exactEngineReason(specs, envUniqGroups) !== undefined;
}

/** Why disk mode needs the exact engine, in words; undefined when it does not. */
function exactEngineReason(
  specs: readonly SequenceSpec[],
  envUniqGroups: readonly (readonly string[])[],
): string | undefined {
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const parentIsFiniteText = (ref: string): boolean =>
    specByName.get(ref.split('.')[0] ?? ref)?.gen?.type === 'text';
  // A weighted-choice advanced_regex can't be materialized lazily (see the
  // streaming builder's matching refusal). Checked on a simple or compound
  // field; exotic nestings (mix/switch/conditional) still route correctly via
  // the streaming builder's throw + auto-fallback, this just makes it explicit.
  const isWeightedAdvancedRegex = (gen: {
    readonly type: string;
    readonly attrs: AttrMap;
  }): boolean =>
    gen.type === 'advanced_regex' && advancedRegexHasWeightedChoice(gen.attrs['value'] ?? '');

  for (const spec of specs) {
    if (spec.uniq) return `uniq="true" on "${spec.name}"`;
    const weighted = `"${spec.name}" has a weighted choice in advanced_regex`;
    if (spec.gen && isWeightedAdvancedRegex(spec.gen)) return weighted;
    for (const field of spec.gens ?? []) {
      if (isWeightedAdvancedRegex(field.gen)) return weighted;
    }
    // A child whose parent isn't a finite text sequence — Engine 2 can't nest there.
    if (spec.parent && !parentIsFiniteText(spec.parent)) {
      return `"${spec.name}" has parent="${spec.parent}", which is not a list of values`;
    }
  }
  const group = envUniqGroups[0];
  if (group !== undefined) return `a <uniq> group over ${group.map((n) => `"${n}"`).join(', ')}`;
  return undefined;
}
