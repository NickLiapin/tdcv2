/**
 * Core rendering pipeline: parse tree → output string.
 *
 * The processor supports the full sequence engine from
 * docs/vision/02-sequences.md:
 *   - <env> attribute extraction (count, seed, inject, local)
 *   - <sequence name="..." [parent="X.Value"]> declarations, materialized
 *     before the main loop; values looked up per iteration via inject
 *     interpolation (`${{Name}}` resolves to the i-th cell of the
 *     corresponding sequence; `${{_count}}` is the 1-based iteration index)
 *   - fixture blocks inside <env>: <before>, <after>, <before_block>,
 *     <after_block>, <delimiter_block>, <before_line>, <after_line>,
 *     <delimiter_line>
 *   - iteration over <block>'s lines for each of `count` cards
 *   - <data> raw-text emission with interpolation
 *   - <gen type="template" value="..." ...> dispatch via the template
 *     registry and data packs (person.*, date.*, and pack addresses like
 *     russia.tax.inn_org, common.id.uuid — including the former "preset"
 *     algorithmic generators, now editable pack data)
 *   - <gen type="file" src="..."/> dispatch
 *   - `if` expressions on <line>, <data>, and inline <gen>
 *   - sequence materialization for text, file, template, number,
 *     regex, advanced_regex, symbol, date, increment, decrement, compute, and
 *     compound sequence fields
 *   - inline dispatch for file, template, number, regex,
 *     advanced_regex without weighted choices, symbol, date, increment, and decrement
 *   - presentation <switch>/<case> inside <line> and nested inside
 *     <case>, with Hamilton-exact percent distribution
 *
 * Ordering rules and newline placement match the 2022-2024 prototype
 * exactly to preserve byte-for-byte output on all pre-existing fixtures.
 */

import { evaluateIf } from '../expr/evaluate.js';
import { checkAssertions, checkRowAssertions, perRowAsserts } from '../sequence/assert.js';
import type { AssertSpec } from '../sequence/assert.js';
import { buildEachInfo, eachRegistries, type EachInfo } from './each.js';
import { resolveExistingDataSourcePath, type DataSourceOptions } from '../data-source/index.js';
import type {
  DocumentContext,
  ContentContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { bundledPacks, resolvePackAddress } from '../data-pack/index.js';
import type { PackRegistry } from '../data-pack/index.js';
import { type Diagnostic, TdcDiagnosticError, nodeRange } from '../errors/index.js';
import { advancedRegexGenerator, parseAdvancedRegexProgram } from '../generators/advanced-regex.js';
import { dateGenerator } from '../generators/date.js';
import { fetchHttpValues, httpSeedFor, HttpServiceError } from '../generators/http.js';
import { resolveHttpSecret } from '../generators/http-secret.js';
import { fileUniform } from '../generators/file.js';
import { numberGenerator } from '../generators/number.js';
import { parseRegexMaxLength, regexGenerator } from '../generators/regex.js';
import { symbolGenerator } from '../generators/symbol.js';
import { createPrng } from '../prng/prng.js';
import { randomPick } from '../prng/random.js';
import {
  buildExactDiskRegistry,
  buildLazyRegistry,
  buildSequences,
  checkEnvUniqCapacity,
  extractEnvDistinctGroups,
  extractEnvUniqGroups,
  extractAsserts,
  extractSequenceSpecs,
  runGenerator,
  StreamUnsupportedError,
} from '../sequence/index.js';
import {
  ExactUniqRepairNeeded,
  IN_MEMORY_FALLBACK_MAX_ROWS,
  withoutTail,
} from '../sequence/exact-uniq.js';
import { extractPoolSpecs, type PoolTables } from '../sequence/pool.js';
import type { UniqArrangement, UniqPlan } from '../sequence/build.js';
import { bucketCountFor } from '../sequence/fingerprint.js';
import { availableParallelism } from 'node:os';
import { buildPoolTables } from '../sequence/pool-build.js';
import type { SequenceRegistry, SequenceSpec } from '../sequence/index.js';
import { resolveTemplate } from '../templates/resolver.js';

import type { AttrMap } from './attrs.js';
import { resolveRenderEngine } from './engine-route.js';

// The router lives in its own module; these names were always reached through this one.
export {
  describeEngineChoice,
  ENGINE_LABELS,
  type EngineChoice,
  explainRenderEngine,
  needsExactEngine,
  resolveRenderEngine,
  specsUseBareParent,
  specsUseDerivedColumn,
  specsUseHttp,
} from './engine-route.js';
import { interpolate } from './interpolate.js';
import {
  contentElements,
  elementAttrs,
  elementKind,
  elementName,
  extractAttrs,
  extractDataAttrs,
  extractDataText,
  findChildElement,
} from './walk.js';

export interface RenderOptions {
  readonly seed?: string;
  readonly count?: number;
  readonly locale?: string;
  /**
   * The locale used when the config does not name one — the project's
   * `tdcv2.config.json`, not the command line.
   *
   * `locale` OVERRIDES what `<env local="…">` declares; this only fills in when
   * `<env>` declares nothing. Folding a project default into `locale` made a
   * config that says `local="ru"` produce English, silently, which is the worst
   * shape a bug can take: the run succeeds and the data is wrong.
   */
  readonly defaultLocale?: string;
  /**
   * Milliseconds since epoch, used by date-based templates as "now".
   * Defaults to real time; tests pass a fixed value for determinism.
   */
  readonly now?: number;
  /** Legacy: force the streaming (Engine 2) engine. Prefer `mode`. */
  readonly stream?: boolean | undefined;
  /** User mode: "memory" (Engine 1) or "disk" (Engine 2/3 auto). Overrides `<env mode>`. */
  readonly mode?: EngineMode | undefined;
  /** Advanced: force a specific engine (1/2/3). Highest precedence; used by tests/parallel. */
  readonly engine?: EngineId | undefined;
  /**
   * A uniq arrangement worked out elsewhere, so this render does not work it
   * out again — see `SequenceBuildOptions.uniqPlan`. What lets one thread do
   * the analysis and several render ranges of the answer.
   */
  readonly uniqPlan?: UniqPlan | undefined;
  /** Called with each uniq group's arrangement as it is worked out, so it can be passed on. */
  readonly onUniqPlan?: ((group: string, arrangement: UniqArrangement) => void) | undefined;
  /** Called as the run advances — see `RenderProgress`. */
  readonly onProgress?: ((progress: RenderProgress) => void) | undefined;
  /** Build the uniq members without making them unique — for the threads that compute the scan. */
  readonly skipEnvUniq?: true;
  /**
   * Throw the uniq-repair refusal instead of taking the in-memory fallback.
   *
   * For the parallel coordinator's planning render. The fallback is right for
   * a single-threaded `mode="disk"` run — one table, one cost. Taken inside a
   * coordinator it repeats per worker: every one of them builds the whole
   * table to render its own slice. The coordinator sets this, catches the
   * typed refusal, and renders the run single-threaded instead.
   */
  readonly refuseUniqFallback?: true;
  /** Fingerprint piles for the uniq hunt; auto-set for the disk engines. See `fingerprint.ts`. */
  readonly uniqFingerprintBuckets?: number | undefined;
  /** Sorted fingerprint files computed elsewhere, per uniq group — the parallel coordinator's. */
  readonly uniqFingerprintFiles?: Readonly<Record<string, readonly string[]>> | undefined;
  /** Colliding rows already found elsewhere, per uniq group — Engine 4's pile workers. */
  readonly uniqExcess?: Readonly<Record<string, readonly number[]>> | undefined;
  /** Base directory for relative `src` paths. Defaults to process cwd. */
  readonly baseDir?: string | undefined;
  /** Extra folders searched by `src="@data/..."` and relative file sources. */
  readonly dataPaths?: readonly string[] | undefined;
  /**
   * Original DSL source text. When provided, render-time errors carry it
   * so the CLI/formatter can render a code snippet with a caret, matching
   * parser/validator diagnostics. Optional — without it, render errors
   * still carry line/column, just no source frame.
   */
  readonly source?: string | undefined;
  /**
   * Loaded data packs. Their dotted addresses resolve as `template`
   * values (a uniform pick from the pack's list), in addition to the
   * builtin template paths.
   */
  readonly packs?: PackRegistry | undefined;
  /**
   * Render only rows `[start, end)` instead of all `count` rows. Used by the
   * parallel CLI: each worker renders one contiguous range, and concatenating
   * the ranges in order reproduces the full output BYTE-FOR-BYTE. `before`
   * fixtures are emitted only when `start === 0`, `after` only when
   * `end === count`, and the block delimiter still keys off the GLOBAL last
   * row — so a range's bytes are exactly what a full render would emit there.
   * Only sound in stream mode with no inline content generators (the render
   * PRNG is sequential, not seekable); the parallel layer enforces that.
   */
  readonly range?: { readonly start: number; readonly end: number } | undefined;
}

interface EnvConfig {
  readonly count: number;
  readonly seed: string;
  readonly locale: string;
  readonly inject: string;
  /* The fixture ELEMENTS, not pre-rendered text.
   *
   * They used to be rendered once, at config time, against an empty registry —
   * which is why `${{Name}}` in a fixture came out as eight literal characters
   * in this implementation while all four ports expanded it. Held as elements
   * so each is rendered beside the row it belongs to. */
  readonly before: OpenCloseElementContext | undefined;
  readonly after: OpenCloseElementContext | undefined;
  readonly beforeBlock: OpenCloseElementContext | undefined;
  readonly afterBlock: OpenCloseElementContext | undefined;
  readonly delimiterBlock: OpenCloseElementContext | undefined;
  readonly beforeLine: OpenCloseElementContext | undefined;
  readonly afterLine: OpenCloseElementContext | undefined;
  readonly delimiterLine: OpenCloseElementContext | undefined;
  readonly regexMaxLength: number;
  /** How the engine was selected — a user mode ("memory"/"disk") or a forced id. */
  readonly engineSelection: EngineSelection;
  /**
   * `<env mode="sequential">` — rows computed strictly in order so `prev()` has
   * a previous row. Carried separately from `engineSelection` because that
   * records WHICH engine, and this records WHY: `engine="1"` picks the same one
   * without promising the ordering `prev()` depends on.
   */
  readonly sequential: boolean;
}

/**
 * Internal engine id:
 * 1 = in-memory (Engine 1): exact everything, fast, bounded by RAM.
 * 2 = streaming (Engine 2): lazy, disk-friendly, multi-threaded; exact except
 *     percent-weighted `uniq`, which it refuses.
 * 3 = exact-on-disk (Engine 3): everything Engine 1 does, at scale, on disk.
 *
 * Engines 2 and 3 hunt uniq duplicates by FINGERPRINT on large runs: 13-byte
 * hash records in piles, sorted as packed integers, verified against the true
 * tuples, and queried by binary search on disk — no in-memory structure over
 * the run. Grew up as experimental engines 4 and 5; measured at 20 GB under a
 * heap capped at 1 GB before it was made the standard path.
 */
export type EngineId = 1 | 2 | 3;

/**
 * A moment of a running generation, for whoever is watching.
 *
 * A big run is silent for minutes at a time — the uniq scan alone was 40
 * minutes of a 20 GB file — and a silent hour is indistinguishable from a hung
 * one. TDC Studio sits on exactly that question, and so does anyone driving
 * the engine from a service. The engine reports through a callback because it
 * cannot know who is asking: the CLI turns it into a status file, Studio into
 * a progress bar, a test into an array.
 *
 * `done` counts rows for the scans and the render, piles for the sort. Reports
 * are throttled at the source (about one per half-percent of a phase), so the
 * callback can be honest work without slowing the run.
 */
export interface RenderProgress {
  readonly phase: 'uniq-scan' | 'uniq-sort' | 'uniq-repair' | 'render';
  readonly done: number;
  readonly total: number;
}

/**
 * User-facing mode. `memory` → Engine 1. `disk` → work off disk: TDC picks the
 * fastest disk engine the config allows — Engine 2 normally, Engine 3 when the
 * config needs exact percentages AND uniqueness together (which Engine 2 can't
 * do lazily). The user never has to know which; the choice is deterministic
 * (by config content, never by hardware), so it stays reproducible.
 */
export type EngineMode = 'memory' | 'disk';

/**
 * Either a user mode, or a forced engine id (advanced/`--engine`, for tests).
 * `why` says where the choice came from, for `check` and the CLI's notes.
 */
export type EngineSelection =
  | { readonly mode: EngineMode; readonly why?: string }
  | { readonly forced: EngineId; readonly why?: string };

interface RenderState {
  readonly inlineCounters: WeakMap<SelfClosingElementContext, () => string>;
  readonly totalCount: number;
}

interface RenderContext {
  readonly prng: () => number;
  readonly locale: string;
  readonly now: number;
  readonly baseDir?: string | undefined;
  readonly dataPaths?: readonly string[] | undefined;
  readonly inject: string;
  readonly iteration: number;
  readonly registry: SequenceRegistry;
  readonly state: RenderState;
  readonly regexMaxLength: number;
  /** Original DSL source, for render-error snippets. */
  readonly source?: string | undefined;
  /** Loaded data packs; addresses resolve as template values. */
  readonly packs?: PackRegistry | undefined;
  /** Repeating sequences by name, so `<line each=…>` knows how to walk them. */
  readonly eachInfo?: ReadonlyMap<string, EachInfo> | undefined;
  /** The pools, so `<line each="Pool">` can print every record of one. */
  readonly pools?: PoolTables | undefined;
}

function createRenderState(totalCount: number): RenderState {
  return {
    inlineCounters: new WeakMap<SelfClosingElementContext, () => string>(),
    totalCount,
  };
}

/**
 * Build a render-time error that funnels through the same
 * `TdcDiagnosticError` channel as parser/validator errors, so the CLI
 * and library API can catch one type and pretty-print it uniformly with
 * a source location (and, when `source` is present, a code snippet).
 *
 * These fire mainly as defence-in-depth: the validator already flags
 * unknown template paths and gen types BEFORE render. But callers
 * that invoke `render()` directly (bypassing validation), or hit a case
 * the validator doesn't cover, now get a located error instead of a bare
 * stack trace — closing the "runtime errors lose line/column" gap.
 *
 * Pass the offending ANTLR node for a precise caret; pass `undefined`
 * for document-level problems (falls back to line 1).
 */
function renderError(
  node: OpenCloseElementContext | SelfClosingElementContext | undefined,
  source: string | undefined,
  message: string,
  opts: { readonly hint?: string; readonly code: string },
): TdcDiagnosticError {
  const range = node ? nodeRange(node) : { line: 1, column: 0, endLine: 1, endColumn: 1 };
  const diagnostic: Diagnostic = {
    severity: 'error',
    source: 'render',
    line: range.line,
    column: range.column,
    endLine: range.endLine,
    endColumn: range.endColumn,
    message,
    ...(opts.hint ? { hint: opts.hint } : {}),
    code: opts.code,
  };
  return new TdcDiagnosticError([diagnostic], source);
}

/**
 * Render a parsed TDC document to its output string. Deterministic on
 * (document, seed, now, locale, count).
 *
 * This is a thin wrapper over `renderStream` that collects every
 * yielded chunk into a single string. Callers that need a streaming
 * consumer (bounded memory regardless of `count`) should iterate
 * `renderStream` directly — see `TDC.toIterator()`.
 */
export function render(document: DocumentContext, options: RenderOptions = {}): string {
  let out = '';
  for (const chunk of renderStream(document, options)) out += chunk;
  return out;
}

/** Default per-request timeout for an http generator, overridable with `timeout=` (seconds). */
const HTTP_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Build a {@link PreparedRender} on the async path: the sequence registry is
 * built synchronously (http generators leaving placeholder columns), then every
 * http column is filled from its service. Only configs with a `type="http"`
 * generator need this — everything else renders identically through the sync
 * `prepareRender`.
 */
export async function prepareRenderAsync(
  document: DocumentContext,
  options: RenderOptions = {},
): Promise<PreparedRender> {
  const prepared = prepareRender(document, options, true);
  const tdc = findTdc(document);
  const envEl = tdc ? findChildElement(tdc.content(), 'env') : undefined;
  await resolveHttpSequences(
    prepared.registry,
    extractSequenceSpecs(envEl),
    prepared.env.seed,
    options.baseDir ?? '.',
  );
  return prepared;
}

/**
 * Async counterpart of {@link render}. Required for a config containing a
 * `type="http"` generator; identical output to `render` for any config without
 * one. The result is non-deterministic when http is used — re-running does not
 * reproduce — which is why such a config never reaches the reproducible
 * streaming path.
 */
export async function renderAsync(
  document: DocumentContext,
  options: RenderOptions = {},
): Promise<string> {
  const prepared = await prepareRenderAsync(document, options);
  let out = '';
  for (const chunk of streamFromPrepared(prepared, options)) out += chunk;
  return out;
}

/**
 * Fill every `type="http"` sequence's placeholder column from its service.
 * Reads the `in=` column (already built, since it is a required earlier
 * sequence) as the batch input, calls the service once for the whole column,
 * and writes the answers back in place. A thrown transport error is wrapped
 * with the sequence name for a clear diagnostic.
 *
 * Each call carries a seed derived from the env seed AND the sequence name.
 * The engine cannot make an http run reproducible — the service decides the
 * values — but it can hand the service what it needs to be reproducible on its
 * own. Deriving per sequence matters: sending the raw env seed would give two
 * http sequences pointed at one service the same seed, and a service that
 * generates from it would answer both with an identical column.
 */
async function resolveHttpSequences(
  registry: SequenceRegistry,
  specs: readonly SequenceSpec[],
  seed: string,
  baseDir: string,
): Promise<void> {
  for (const spec of specs) {
    if (spec.gen?.type !== 'http') continue;
    const seq = registry[spec.name];
    if (!seq) continue;
    const count = seq.values.length;

    const inName = spec.gen.attrs['in'];
    const inputs =
      inName === undefined ? undefined : (registry[inName]?.values ?? []).map((v) => v ?? '');

    // Resolved per sequence and never cached: two sequences may sign with two
    // different secrets, and a config that names an unset variable should say so
    // in terms of the sequence the reader wrote.
    const secretSpec = spec.gen.attrs['secret'];
    let secret: string | undefined;
    if (secretSpec !== undefined && secretSpec.trim() !== '') {
      try {
        secret = resolveHttpSecret(secretSpec, baseDir);
      } catch (err) {
        throw new Error(
          `http service for sequence "${spec.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let values: string[];
    try {
      values = await fetchHttpValues({
        src: spec.gen.attrs['src'] ?? '',
        count,
        inputs,
        onError: spec.gen.attrs['on_error'] === 'empty' ? 'empty' : 'fail',
        timeoutMs: parseHttpTimeout(spec.gen.attrs['timeout']),
        seed: httpSeedFor(seed, spec.name),
        secret,
      });
    } catch (err) {
      if (err instanceof HttpServiceError) {
        throw new Error(`http service for sequence "${spec.name}" at ${err.url} ${err.message}`);
      }
      throw err;
    }
    const target = seq.values as (string | undefined)[];
    for (let i = 0; i < count; i++) target[i] = values[i];
  }
}

/** `timeout="30"` → 30_000 ms. Falls back to the default on absent/invalid input. */
function parseHttpTimeout(raw: string | undefined): number {
  if (raw === undefined) return HTTP_DEFAULT_TIMEOUT_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : HTTP_DEFAULT_TIMEOUT_MS;
}

/**
 * Streaming variant of `render`. Yields output in chunks — one chunk
 * per card (plus the fixture chunks before/after the loop). Memory use
 * stays bounded by the largest single card plus the sequence registry
 * (which is materialised up-front regardless).
 *
 * Deterministic on (document, seed, now, locale, count) — identical in
 * output to `render()` when concatenated, byte-for-byte.
 */
/** Render-time fixture wrappers whose bodies render via the sequential PRNG. */
const FIXTURE_NAMES = [
  'before',
  'after',
  'before_block',
  'after_block',
  'delimiter_block',
  'before_line',
  'after_line',
  'delimiter_line',
] as const;

/**
 * True if the config has any INLINE render-time `<gen>` or `<switch>` — one
 * placed directly in a `<block>`/fixture line rather than inside a
 * `<sequence>`. Those draw from the render loop's SEQUENTIAL prng (row 0, 1, 2…
 * in order), so they are not seekable and a row range can't be rendered
 * independently. Sequences (under `<env>`) are seekable in stream mode and
 * don't count. Used by the parallel CLI to refuse configs it can't split
 * without changing the output.
 */
/**
 * Whether the config asks for uniqueness across the whole run.
 *
 * A `uniq="true"` sequence or a `<uniq>` group is a promise about the finished
 * dataset, not about any one row. A worker rendering rows 0..99 can only make
 * its own hundred distinct, and four workers would each do that and duplicate
 * across the boundaries — silently, since every range looks correct on its own.
 * So `--jobs` refuses rather than split it.
 */
export function hasUniqueness(document: DocumentContext): boolean {
  const tdc = findTdc(document);
  const env = tdc ? findChildElement(tdc.content(), 'env') : undefined;
  if (!env) return false;
  if (extractEnvUniqGroups(env).length > 0) return true;
  return extractSequenceSpecs(env).some((spec) => spec.uniq === true);
}

/**
 * Uniqueness that a row range cannot be rendered under, even given the
 * arrangement worked out for the whole file.
 *
 * An env-level `<uniq>` is not one: it rearranges whole columns, the answer is
 * a small map of which rows moved where, and a thread handed that map resolves
 * its own rows without knowing what the others hold. `uniq="true"` on a single
 * sequence is: it rearranges the gens INSIDE one compound column, which no
 * per-row resolver reproduces.
 */
/**
 * The env-level `<uniq>` groups' members, as the config declares them.
 *
 * For the coordinator that hands the scan out: it has to name each group the
 * same way the engine does, since the engine looks its pre-computed records up
 * by that name. The engine drops a member that produced no sequence at all, so
 * a name can in principle differ — and then the records are simply not found
 * and the engine computes the scan itself. Slower, never wrong.
 */
export function envUniqGroupsOf(document: DocumentContext): readonly (readonly string[])[] {
  const tdc = findTdc(document);
  const env = tdc ? findChildElement(tdc.content(), 'env') : undefined;
  return env ? extractEnvUniqGroups(env) : [];
}

/**
 * Refuse a uniq group that cannot produce the rows asked of it — cheaply, and
 * without generating anything.
 *
 * The renderer does this before choosing an engine. The parallel coordinator
 * needs it before choosing to spawn threads: an impossible config used to set
 * every core computing tuples for an arrangement that could never exist, and
 * only refuse once they had finished.
 */
export function checkUniqFeasible(document: DocumentContext, count: number): void {
  const tdc = findTdc(document);
  const env = tdc ? findChildElement(tdc.content(), 'env') : undefined;
  if (!env) return;
  checkEnvUniqCapacity(extractEnvUniqGroups(env), extractSequenceSpecs(env), count);
}

export function hasUnsplittableUniqueness(document: DocumentContext): boolean {
  const tdc = findTdc(document);
  const env = tdc ? findChildElement(tdc.content(), 'env') : undefined;
  if (!env) return false;
  return extractSequenceSpecs(env).some((spec) => spec.uniq === true);
}

/**
 * Whether the config carries an `<assert each="…"/>`.
 *
 * A per-row assertion names the FIRST failing row, and "first" is a statement
 * about the whole run. Workers each own a range and each stop at their own first
 * failure, so the row a reader is shown would be whichever thread got there —
 * a different number on the same config and the same seed. So a config with one
 * runs single-threaded, and the failure it reports is the true first row.
 */
export function hasPerRowAssertion(document: DocumentContext): boolean {
  const tdc = findTdc(document);
  const env = tdc ? findChildElement(tdc.content(), 'env') : undefined;
  if (!env) return false;
  return perRowAsserts(extractAsserts(env)).length > 0;
}

export function hasInlineRenderGenerators(document: DocumentContext): boolean {
  const tdc = findTdc(document);
  if (!tdc) return false;
  const env = findChildElement(tdc.content(), 'env');
  const roots = [findChildElement(tdc.content(), 'block')];
  if (env) for (const name of FIXTURE_NAMES) roots.push(findChildElement(env.content(), name));
  return roots.some((root) => root !== undefined && subtreeHasGenOrSwitch(root.content()));
}

function subtreeHasGenOrSwitch(content: ContentContext | null): boolean {
  for (const el of contentElements(content)) {
    const k = elementKind(el);
    if (!k || k.kind === 'data') continue;
    const name = elementName(k.node);
    if (name === 'gen' || name === 'switch') return true;
    if (k.kind === 'open' && subtreeHasGenOrSwitch(k.node.content())) return true;
  }
  return false;
}

/** Everything a consumer needs after the sequences are built. */
export interface PreparedRender {
  readonly tdc: OpenCloseElementContext;
  readonly blockEl: OpenCloseElementContext;
  readonly env: EnvConfig;
  readonly registry: SequenceRegistry;
  readonly now: number;
  /** The sequential PRNG, already advanced by sequence materialisation. */
  readonly prng: () => number;
  /** Repeating sequences by name, for `<line each=…>`. */
  readonly eachInfo: ReadonlyMap<string, EachInfo>;
  /** The pools, for `<line each="Pool">`. */
  readonly pools: PoolTables;
  /** The `<sequence>` specs, in declaration order — what the object API reports. */
  readonly sequenceSpecs: readonly SequenceSpec[];
  /** `<assert each="…"/>` — answered row by row, in the loop below. */
  readonly perRowAsserts: readonly AssertSpec[];
}

/**
 * Parse the document and build the sequence registry — everything that happens
 * before output is produced. Shared by the text renderer and the columnar
 * (typed/Parquet) writer so both see exactly the same data for a given seed.
 */
export function prepareRender(
  document: DocumentContext,
  options: RenderOptions = {},
  deferHttp = false,
): PreparedRender {
  const tdc = findTdc(document);
  if (!tdc) {
    throw renderError(undefined, options.source, 'document has no <tdc> root element', {
      hint: 'A TDC config must have a single top-level <tdc>…</tdc> element.',
      code: 'TDC001',
    });
  }

  const envEl = findChildElement(tdc.content(), 'env');
  const blockEl = findChildElement(tdc.content(), 'block');
  if (!blockEl) {
    throw renderError(tdc, options.source, '<tdc> has no <block> child — nothing to render', {
      hint: 'Add a <block>…</block> describing the layout of one generated card.',
      code: 'TDC002',
    });
  }

  const env = extractEnvConfig(tdc, envEl, options);
  const prng = createPrng(env.seed);
  const now = options.now ?? Date.now();

  // Sequences materialize up-front, consuming the prng in declaration
  // order. This must happen BEFORE the main render loop (which also
  // consumes the prng via in-line generators) so child sequences see
  // the right parent values and the consumption order is stable.
  const sequenceSpecs = extractSequenceSpecs(envEl);
  const eachInfo = buildEachInfo(sequenceSpecs);
  const envUniqGroups = extractEnvUniqGroups(envEl);
  const envDistinctGroups = extractEnvDistinctGroups(envEl);
  const packOptions = {
    regexMaxLength: env.regexMaxLength,
    dataSources: dataSourceOptions(options),
    packs: options.packs ?? bundledPacks(),
  };
  // Pools are computed BEFORE anything else, off a derived seed, so a run that
  // gains a pool keeps every other column exactly where it was.
  const pools = buildPoolTables(extractPoolSpecs(envEl), env.seed, env.locale, now, packOptions);
  const buildOptions = {
    ...packOptions,
    ...(options.uniqPlan !== undefined ? { uniqPlan: options.uniqPlan } : {}),
    ...(options.onUniqPlan !== undefined ? { onUniqPlan: options.onUniqPlan } : {}),
    ...(options.skipEnvUniq ? { skipEnvUniq: true as const } : {}),
    ...(options.refuseUniqFallback ? { refuseUniqFallback: true as const } : {}),
    ...(options.uniqExcess !== undefined ? { uniqExcess: options.uniqExcess } : {}),
    ...(options.uniqFingerprintBuckets !== undefined
      ? { uniqFingerprintBuckets: options.uniqFingerprintBuckets }
      : {}),
    ...(options.uniqFingerprintFiles !== undefined
      ? { uniqFingerprintFiles: options.uniqFingerprintFiles }
      : {}),
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    seed: env.seed,
    // A `<data>` inside a `<case>` interpolates by the document's own marker, so
    // a config that set `inject=` to emit `${{…}}` literally still does.
    inject: env.inject,
    pools,
    // `prev()` may look back one row only when the rows are computed in order.
    ...(env.sequential ? { sequential: true as const } : {}),
  };
  // Resolve the concrete engine. A user MODE picks it from the config: disk →
  // Engine 2 normally, Engine 3 when the config needs exact percentages AND
  // uniqueness together (Engine 2 can't do that lazily). Deterministic — same
  // config → same engine everywhere.
  const engine = resolveRenderEngine(env.engineSelection, sequenceSpecs, envUniqGroups);
  // Engine 2 is a lazy registry (O(#sequences) memory). Engine 1 materializes
  // in RAM. Engine 3 (exact-on-disk) is built in stages — see exact-disk.ts.
  // Only the AUTO-routed default (mode="disk") falls back to Engine 1 when the
  // streaming engine can't handle a config — an invisible backstop that keeps
  // "disk by default" from ever breaking. Explicitly forcing Engine 2
  // (engine="2" / --stream) is respected: it still throws, so the user who asked
  // for streaming is told when it can't be done rather than silently downgraded.
  /*
   * Can the uniq groups cover `count` at all? Asked here, before an engine is
   * chosen, because the answer does not depend on which one runs.
   *
   * It used to be asked inside the in-memory builder alone. A config routed
   * anywhere else got no answer: an infeasible billion-row group ran for
   * nineteen minutes and filled the disk instead of being turned away in
   * milliseconds. The check reads the SPECS — no column is built to answer it —
   * and it costs 88 ms on a 400,000-row config.
   */
  checkEnvUniqCapacity(envUniqGroups, sequenceSpecs, env.count);

  const autoRoutedDisk = 'mode' in env.engineSelection && env.engineSelection.mode === 'disk';
  /*
   * The disk engines carry uniq tuples as fingerprints once the run is big
   * enough to pay for hashing (a million rows — four piles per core). Below
   * that the text path runs, exact strings and all, which is also what keeps
   * every existing small-config byte where it was.
   */
  if (engine !== 1 && buildOptions.uniqFingerprintBuckets === undefined) {
    Object.assign(buildOptions, {
      uniqFingerprintBuckets: bucketCountFor(env.count, availableParallelism()),
    });
  }
  let registry: SequenceRegistry;
  if (engine === 2) {
    try {
      registry = buildLazyRegistry(
        sequenceSpecs,
        env.count,
        env.seed,
        env.locale,
        now,
        buildOptions,
        {
          uniq: envUniqGroups,
          distinct: envDistinctGroups,
        },
      );
    } catch (err) {
      /*
       * Two ways this engine gives up, and both mean the same thing: only the
       * whole table in memory can answer.
       *
       * `StreamUnsupportedError` — the config has a shape the lazy path cannot
       * express at all. `ExactUniqRepairNeeded` — it CAN express it, but the
       * uniq pool turned out too tight to repair a few rows without holding
       * everything. The second used to escape here, so a config that should
       * have quietly fallen back reached the user as an error whose own text
       * announced a fallback that never happened.
       */
      const givesUp = err instanceof StreamUnsupportedError || err instanceof ExactUniqRepairNeeded;
      if (!autoRoutedDisk || !givesUp) throw err;
      // Same guard as the exact-disk engine: past what the in-memory engine
      // can hold, the fallback is a slow crash, not a fallback.
      if (err instanceof ExactUniqRepairNeeded && env.count > IN_MEMORY_FALLBACK_MAX_ROWS) {
        throw new Error(
          `${withoutTail(err.message)} — and at ${String(env.count)} rows the ` +
            `in-memory engine cannot take over. Widen the uniq columns' values ` +
            `(more distinct names, wider ranges…) or lower the count.`,
        );
      }
      // Auto-routed disk mode + a config the streaming engine can't do lazily
      // (a rare uniq/distinct/parent edge case) → fall back to the in-memory
      // engine. Same result the old memory default produced.
      registry = buildSequences(sequenceSpecs, env.count, prng, env.locale, now, {
        ...buildOptions,
        envDistinctGroups,
        envUniqGroups,
      });
    }
  } else if (engine === 3) {
    /*
     * Engine 4 is Engine 3 with the duplicate hunt split into piles. Same
     * pipeline, same result — the piles change how the tuples are looked
     * through, not which ones collide. Kept as its own id so the two can be
     * measured against each other on one config.
     */
    registry = buildExactDiskRegistry(
      sequenceSpecs,
      env.count,
      env.seed,
      prng,
      env.locale,
      now,
      buildOptions,
      envUniqGroups,
      envDistinctGroups,
      // Named rather than routed to: `--engine 3` and `engine="3"` say WHICH
      // engine, so a config too tight for it is refused instead of handed to
      // another. `mode="disk"` says what the run may cost, and still falls back.
      'forced' in env.engineSelection,
    );
  } else {
    registry = buildSequences(sequenceSpecs, env.count, prng, env.locale, now, {
      ...buildOptions,
      envDistinctGroups,
      envUniqGroups,
      // On the async path an http generator produces a placeholder column here;
      // resolveHttpSequences fills it after the whole registry is built.
      httpDeferred: deferHttp,
    });
  }
  // The run is finished; now the config gets to check its own output. Here rather
  // than in the output half so both the sync and the async path are covered, and
  // so a failed assertion stops before a single line is written — a file that
  // exists is a file someone will use.
  const asserts = extractAsserts(envEl);
  checkAssertions(asserts, registry, sequenceSpecs, env.count);

  return {
    tdc,
    blockEl,
    env,
    registry,
    now,
    prng,
    eachInfo,
    pools,
    sequenceSpecs,
    perRowAsserts: perRowAsserts(asserts),
  };
}

export function* renderStream(
  document: DocumentContext,
  options: RenderOptions = {},
): Generator<string, void, void> {
  yield* streamFromPrepared(prepareRender(document, options), options);
}

/**
 * The output half of a render: turn an already-built {@link PreparedRender} into
 * text chunks. Split out so the sync (`renderStream`) and async (`renderAsync`)
 * paths share it — only the registry build differs between them, never the
 * assembly.
 */
export function* streamFromPrepared(
  prepared: PreparedRender,
  options: RenderOptions = {},
): Generator<string, void, void> {
  const { blockEl, env, registry, now, prng, eachInfo, pools } = prepared;
  const rowAsserts = prepared.perRowAsserts;
  const state = createRenderState(env.count);

  const items = outputItems(blockEl.content());

  // Range support (parallel CLI): render only [start, end). Clamp to the
  // dataset so an out-of-range request is a no-op rather than an error.
  const start = Math.max(0, Math.min(options.range?.start ?? 0, env.count));
  const end = Math.max(start, Math.min(options.range?.end ?? env.count, env.count));

  // Which row a fixture reads is the contract the four ports already keep:
  // `before` sees the first row, `after` the last, and everything else the row
  // it stands beside. A fixture draws nothing, so the prng is a constant zero.
  const fixtureCtx = (iteration: number): RenderContext => ({
    eachInfo,
    pools,
    prng: () => 0,
    locale: env.locale,
    now,
    baseDir: options.baseDir,
    dataPaths: options.dataPaths,
    inject: env.inject,
    iteration,
    registry,
    state,
    regexMaxLength: env.regexMaxLength,
    source: options.source,
    packs: options.packs ?? bundledPacks(),
  });

  if (start === 0) {
    const head = renderFixture(env.before, fixtureCtx(0));
    if (head.length > 0) yield head;
  }

  // About one report per half-percent: cheap enough to leave on always.
  const reportEvery = Math.max(1, Math.floor((end - start) / 200));
  for (let i = start; i < end; i++) {
    if (options.onProgress && (i - start) % reportEvery === 0) {
      options.onProgress({ phase: 'render', done: i - start, total: end - start });
    }
    // Before the row is written, not after: a row that fails its own config's
    // claim should not reach the file when the engine can still help it.
    if (rowAsserts.length > 0) checkRowAssertions(rowAsserts, registry, i);
    // Build ONE card's worth of output in a local string, then yield
    // it as a single chunk. This keeps memory bounded by the size of
    // one card (rather than the whole output) while preserving the
    // byte-exact output contract.
    const fx = fixtureCtx(i);
    let card = renderFixture(env.beforeBlock, fx);
    // The OUTPUT lines, not the <line> ELEMENTS. One `<line each="Items">`
    // produces as many output lines as the list has elements, and the three
    // per-line fixtures are documented as wrapping "the lines of a record" — so
    // they have to see what the reader sees. They used to see the elements, and
    // `<delimiter_line>` between the repetitions of an each= line therefore did
    // nothing at all: no comma between the members of an array, in silence.
    const output: string[] = [];
    for (const item of items) {
      output.push(
        ...renderItem(item, {
          eachInfo,
          pools,
          prng,
          locale: env.locale,
          now,
          baseDir: options.baseDir,
          dataPaths: options.dataPaths,
          inject: env.inject,
          iteration: i,
          registry,
          state,
          regexMaxLength: env.regexMaxLength,
          source: options.source,
          packs: options.packs ?? bundledPacks(),
        }),
      );
    }
    for (let lineIdx = 0; lineIdx < output.length; lineIdx++) {
      card += renderFixture(env.beforeLine, fx);
      card += output[lineIdx] ?? '';
      card += renderFixture(env.afterLine, fx);
      if (lineIdx < output.length - 1) card += renderFixture(env.delimiterLine, fx);
    }
    card += renderFixture(env.afterBlock, fx);
    if (i < env.count - 1) card += renderFixture(env.delimiterBlock, fx);
    if (card.length > 0) yield card;
  }

  options.onProgress?.({ phase: 'render', done: end - start, total: end - start });
  if (end === env.count) {
    const tail = renderFixture(env.after, fixtureCtx(Math.max(0, env.count - 1)));
    if (tail.length > 0) yield tail;
  }
}

function lineIfPasses(
  line: OpenCloseElementContext,
  registry: SequenceRegistry,
  iteration: number,
): boolean {
  const attrs = elementAttrs(line);
  const expr = attrs['if'];
  if (!expr) return true;
  // An `each` line asks its `if=` of every element instead, with the element in scope.
  if ((attrs['each'] ?? '').trim() !== '') return true;
  return evaluateIf(expr, registry, iteration);
}

function findTdc(doc: DocumentContext): OpenCloseElementContext | undefined {
  for (const el of doc.element()) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === 'tdc') return k.node;
  }
  return undefined;
}

function extractEnvConfig(
  tdcEl: OpenCloseElementContext,
  envEl: OpenCloseElementContext | undefined,
  options: RenderOptions,
): EnvConfig {
  const tdcAttrs = extractAttrs(tdcEl.attr());
  const attrs = envEl ? extractAttrs(envEl.attr()) : {};
  const count = options.count ?? (attrs['count'] ? Number(attrs['count']) : 10);
  const seed = options.seed ?? attrs['seed'] ?? String(Math.random());
  const locale = options.locale ?? attrs['local'] ?? options.defaultLocale ?? 'en';
  const regexMaxLength = parseRegexMaxLength(tdcAttrs['regex_max_length']);

  const fixtureEl = (name: string): OpenCloseElementContext | undefined =>
    envEl ? findChildElement(envEl.content(), name) : undefined;

  return {
    count,
    seed,
    locale,
    inject: attrs['inject'] ?? '${{%}}',
    before: fixtureEl('before'),
    after: fixtureEl('after'),
    beforeBlock: fixtureEl('before_block'),
    afterBlock: fixtureEl('after_block'),
    delimiterBlock: fixtureEl('delimiter_block'),
    beforeLine: fixtureEl('before_line'),
    afterLine: fixtureEl('after_line'),
    delimiterLine: fixtureEl('delimiter_line'),
    regexMaxLength,
    engineSelection: resolveEngineSelection(attrs, options),
    sequential: attrs['mode'] === 'sequential',
  };
}

/**
 * Resolve the engine SELECTION (mode or forced id), most-specific wins:
 *   1. `options.engine` (advanced / `--engine N`) → forced id
 *   2. `options.stream` (legacy `--stream`) → forced Engine 2
 *   3. `options.mode` (`--mode`/`--disk`) → mode
 *   4. `<env engine="1|2|3">` → forced id
 *   5. `<env mode="stream">` → forced Engine 2 (legacy alias)
 *   6. `<env mode="memory|disk">` → mode
 *   7. default → disk
 * `disk` is the default: file generation always goes through the bounded-memory
 * engines (streaming / exact-on-disk), auto-picked from the config. The in-memory
 * engine (Engine 1) is no longer a default — it survives as an internal backstop
 * (the object API, the Engine-3 fallback, and an explicit `mode="memory"` /
 * `engine="1"` escape hatch). A user MODE (`disk`) is resolved to a concrete
 * engine later, from the config — deterministically, never from hardware.
 */
export function resolveEngineSelection(attrs: AttrMap, options: RenderOptions): EngineSelection {
  if (options.engine !== undefined) {
    return { forced: options.engine, why: `engine ${String(options.engine)} was asked for` };
  }
  if (options.stream === true) return { forced: 2, why: 'streaming was asked for' };
  if (options.mode !== undefined) {
    return { mode: options.mode, why: `mode "${options.mode}" was asked for` };
  }
  const engineAttr = attrs['engine'];
  const modeAttr = attrs['mode'];
  /*
   * `engine=` wins over `mode=` — except when the two contradict each other.
   *
   * `mode="sequential"` is not a preference about speed, it is a promise that
   * row N is computed after row N-1, which only Engine 1 keeps. Letting
   * `engine="2"` quietly override it produced the worst possible message: the
   * run failed saying "add mode=sequential" to a config that already said it.
   * Naming both attributes is the whole fix.
   */
  if (
    modeAttr === 'sequential' &&
    engineAttr !== undefined &&
    engineAttr !== '' &&
    engineAttr !== '1'
  ) {
    throw new Error(
      `engine="${engineAttr}" contradicts mode="sequential": rows must be computed in order, ` +
        'and only engine 1 does that. Drop one of the two.',
    );
  }
  if (engineAttr !== undefined && engineAttr !== '') {
    return { forced: parseEngineId(engineAttr), why: `engine="${engineAttr}" on <env>` };
  }
  if (modeAttr === 'stream') return { forced: 2, why: 'mode="stream" on <env>' };
  /*
   * `sequential` computes rows strictly in order, which is what `prev()` needs
   * and what the streaming engines cannot promise: Engine 2 resolves ANY row in
   * O(1) without touching the one before it, and that is its whole design. So
   * the mode forces Engine 1, which materialises in order.
   *
   * The cost is Engine 1's: the run is held in memory. That is the honest price
   * of a column that reads its own past, and it is paid only by a config that
   * asked for it.
   */
  if (modeAttr === 'sequential') return { forced: 1, why: 'mode="sequential" on <env>' };
  if (modeAttr === 'memory') return { mode: modeAttr, why: 'mode="memory" on <env>' };
  if (modeAttr === 'disk') return { mode: modeAttr };
  if (modeAttr !== undefined && modeAttr !== '') {
    throw new Error(`invalid mode "${modeAttr}" — expected "memory", "disk" or "sequential"`);
  }
  return { mode: 'disk' };
}

function parseEngineId(raw: string): EngineId {
  if (raw === '1' || raw === '2' || raw === '3') return Number(raw) as EngineId;
  throw new Error(
    `invalid engine "${raw}" — expected "1" (in-memory), "2" (streaming), or "3" (exact-on-disk)`,
  );
}

/**
 * A fixture, rendered beside the row it belongs to.
 *
 * `${{Name}}` IS expanded here — the four ports always expanded it and this
 * implementation did not, which made a header naming a column come out as eight
 * literal characters in one implementation out of five. What stays refused is a
 * `<gen>` inside a fixture (TDC131): a generator there would emit a CONSTANT
 * that looks like a drawn value. Reading a column already drawn is a different
 * thing, and it is what lets a record wrap a nested list in its own fields.
 *
 * The prng is a constant zero and nothing draws from it, so adding a fixture
 * leaves every column exactly where it was.
 */
function renderFixture(el: OpenCloseElementContext | undefined, ctx: RenderContext): string {
  if (!el) return '';
  let out = '';
  for (const item of outputItems(el.content())) {
    // A fixture line is one output line, and renderLine hands back the LINES. Its `if=` is read on
    // the row the fixture stands beside: it used to be ignored in all five, so a header the config
    // said to leave out was printed anyway.
    out += renderItem(item, ctx).join('');
  }
  return out;
}

/** The `<line>`s and `<group>`s of a `<block>`, a fixture or a group, in order. */
function outputItems(content: ContentContext | null): OpenCloseElementContext[] {
  const out: OpenCloseElementContext[] = [];
  for (const el of contentElements(content)) {
    const k = elementKind(el);
    if (k?.kind !== 'open') continue;
    const name = elementName(k.node);
    if (name === 'line' || name === 'group') out.push(k.node);
  }
  return out;
}

/** One `<line>` or `<group>` of a block: the output lines it prints on this row. */
function renderItem(item: OpenCloseElementContext, ctx: RenderContext): string[] {
  if (elementName(item) === 'group') return renderGroup(item, ctx);
  if (!lineIfPasses(item, ctx.registry, ctx.iteration)) return [];
  return renderLine({ ...ctx, line: item });
}

/**
 * `<group>` — several lines printed as one unit.
 *
 * With `each=` the lines inside print once per element of a list or record of a pool, in order,
 * with that element in scope for every one of them — which is what a record of SEVERAL lines needs,
 * and what a nested document needs: a department, then its doctors, then its closing bracket, for
 * each department in turn. An inner `each` sees the outer element, so `Doctors.dept.id == Depts.id`
 * picks the doctors of the department being printed. The positions count as on a line: over the
 * elements the group's `if=` keeps.
 *
 * Without `each=`, `if=` decides the whole group once, in the scope around it — one condition for
 * many lines instead of the same one copied onto each.
 */
function renderGroup(group: OpenCloseElementContext, ctx: RenderContext): string[] {
  const attrs = elementAttrs(group);
  const name = (attrs['each'] ?? '').trim();
  const expr = attrs['if'];
  const keep = (registry: SequenceRegistry): boolean =>
    !expr || evaluateIf(expr, registry, ctx.iteration);
  const scopes =
    name === ''
      ? [ctx.registry].filter(keep)
      : eachRegistries(name, ctx.registry, ctx.iteration, ctx.eachInfo, ctx.pools, keep);
  const items = outputItems(group.content());
  return scopes.flatMap((registry) =>
    items.flatMap((item) => renderItem(item, { ...ctx, registry })),
  );
}

/**
 * One line — or, with `each="NAME"`, one line PER ELEMENT of that list.
 *
 * The loop hands each render an overlay registry where `NAME` resolves to the
 * current element; everything else still resolves per card, which is what makes
 * a foreign key on the repeated line point at the right parent.
 *
 * Zero elements emits nothing at all, exactly as `if=` suppresses a line — a
 * customer with no orders must not leave a blank row behind.
 */
function renderLine(ctx: RenderContext & { readonly line: OpenCloseElementContext }): string[] {
  const name = elementAttrs(ctx.line)['each'];
  if (name === undefined || name.trim() === '') {
    return [renderContent(ctx.line.content(), ctx) + '\n'];
  }
  // The line's own `if=` is asked of each element, with that element in scope.
  const expr = elementAttrs(ctx.line)['if'];
  const keep = (registry: SequenceRegistry): boolean =>
    !expr || evaluateIf(expr, registry, ctx.iteration);
  return eachRegistries(
    name.trim(),
    ctx.registry,
    ctx.iteration,
    ctx.eachInfo,
    ctx.pools,
    keep,
  ).map((registry) => renderContent(ctx.line.content(), { ...ctx, registry }) + '\n');
}

function renderContent(content: ContentContext | null, ctx: RenderContext): string {
  let out = '';
  for (const el of contentElements(content)) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data') {
      const attrs = extractDataAttrs(k.node);
      const expr = attrs['if'];
      if (expr && !evaluateIf(expr, ctx.registry, ctx.iteration)) continue;
      out += interpolate(extractDataText(k.node), ctx.inject, ctx.iteration, ctx.registry);
      continue;
    }
    if (k.kind === 'self') {
      const name = elementName(k.node);
      if (name === 'gen') {
        const attrs = elementAttrs(k.node);
        const expr = attrs['if'];
        if (expr && !evaluateIf(expr, ctx.registry, ctx.iteration)) continue;
        out += renderGen(k.node, attrs, ctx);
      }
      continue;
    }
    // Note: <mix> distributions live in <env> (referenced via ${{Name}}), not
    // in the output block. The block is formatting-only.
  }
  return out;
}

function renderGen(node: SelfClosingElementContext, attrs: AttrMap, ctx: RenderContext): string {
  const type = attrs['type'] ?? '';
  switch (type) {
    case 'template': {
      const path = attrs['value'] ?? '';
      // Soft/hard locale resolution (see build.ts). Data-pack addresses take
      // precedence over builtin template paths. A pack GENERATOR runs its
      // stored <gen> spec (one value); a pack DATA list is a uniform pick.
      const packEntry = ctx.packs?.get(
        resolvePackAddress(path, attrs['local'] ?? ctx.locale, ctx.packs),
      );
      if (packEntry?.generator) {
        return (
          runGenerator(packEntry.generator, 1, ctx.prng, ctx.locale, ctx.now, {
            regexMaxLength: ctx.regexMaxLength,
            dataSources: dataSourceOptions(ctx),
            packs: ctx.packs,
          })[0] ?? ''
        );
      }
      if (packEntry?.values) return randomPick(ctx.prng, packEntry.values);
      const source = resolveTemplate(path);
      if (!source) {
        throw renderError(node, ctx.source, `unknown template path "${path}"`, {
          hint: 'Check for a typo in the template path, or see https://nickliapin.github.io/tdcv2/docs/generators/template',
          code: 'TDC071',
        });
      }
      return source(ctx.prng, attrs, ctx.locale, ctx.now);
    }
    case 'file': {
      const src = attrs['src'] ?? '';
      if (attrs['row'] !== undefined) {
        throw renderError(node, ctx.source, 'row-linked file generators require sequence context', {
          hint: 'The `row="…"` attribute only works on a <gen> inside a <sequence>, not on an inline <gen> in a <line>.',
          code: 'TDC160',
        });
      }
      // File generator cached per path would be ideal, but for
      // fixtures-focused Phase 3 this path is not exercised; build on
      // demand. Cache can land in a later phase if perf matters.
      const resolvedSrc = resolveExistingDataSourcePath(src, dataSourceOptions(ctx)).path;
      const gen = fileUniform(resolvedSrc, {
        column: attrs['column'],
        header: attrs['header'],
        delimiter: attrs['delimiter'],
      });
      return gen(1, ctx.prng)[0] ?? '';
    }
    case 'number': {
      const numGen = numberGenerator({
        range: attrs['value'],
        length: attrs['length'],
        percent: attrs['percent'],
        firstZero: attrs['first_zero'] === undefined ? undefined : attrs['first_zero'] !== 'false',
        include: attrs['include'],
        exclude: attrs['exclude'],
      });
      return numGen(1, ctx.prng)[0] ?? '';
    }
    case 'regex': {
      const regexGen = regexGenerator({
        pattern: attrs['value'] ?? '',
        regexMaxLength: attrs['regex_max_length'] ?? ctx.regexMaxLength,
      });
      return regexGen(1, ctx.prng)[0] ?? '';
    }
    case 'advanced_regex': {
      const pattern = attrs['value'] ?? '';
      const regexMaxLength = attrs['regex_max_length'] ?? ctx.regexMaxLength;
      const program = parseAdvancedRegexProgram(pattern, { regexMaxLength });
      if (program.weightedChoiceCount > 0) {
        throw renderError(
          node,
          ctx.source,
          'advanced_regex weighted choices require sequence context',
          {
            hint: 'Inline rendering cannot guarantee exact percentages. Move this <gen> into a <sequence> so the distribution is computed over the whole count.',
            code: 'TDC161',
          },
        );
      }
      const advancedRegexGen = advancedRegexGenerator({ pattern, regexMaxLength });
      return advancedRegexGen(1, ctx.prng)[0] ?? '';
    }
    case 'symbol': {
      const symGen = symbolGenerator({
        alphabet: attrs['alphabet'],
        value: attrs['value'],
        include: attrs['include'],
        exclude: attrs['exclude'],
        length: attrs['length'],
      });
      return symGen(1, ctx.prng)[0] ?? '';
    }
    case 'date': {
      const dGen = dateGenerator(
        {
          value: attrs['value'],
          from: attrs['from'],
          to: attrs['to'],
          range: attrs['range'],
          format: attrs['format'],
          local: attrs['local'],
          oldest: attrs['oldest'],
          youngest: attrs['youngest'],
          precision: attrs['precision'],
        },
        ctx.locale,
        ctx.now,
      );
      return dGen(1, ctx.prng)[0] ?? '';
    }
    case 'increment':
    case 'decrement':
      return inlineCounter(node, attrs, type, ctx)();
    default:
      throw renderError(node, ctx.source, `gen type "${type}" not yet supported`, {
        hint: 'This generator type is not implemented for inline <gen>. See https://nickliapin.github.io/tdcv2/docs/reference/generators',
        code: 'TDC041',
      });
  }
}

function dataSourceOptions(options: DataSourceOptions): DataSourceOptions {
  return {
    baseDir: options.baseDir,
    dataPaths: options.dataPaths,
  };
}

function inlineCounter(
  node: SelfClosingElementContext,
  attrs: AttrMap,
  type: 'increment' | 'decrement',
  ctx: RenderContext,
): () => string {
  const existing = ctx.state.inlineCounters.get(node);
  if (existing) return existing;

  const start = attrs['value'] === undefined ? 0 : Number(attrs['value']);
  const step = attrs['step'] === undefined ? 1 : Number(attrs['step']);
  if (!Number.isFinite(start) || !Number.isFinite(step)) {
    throw renderError(node, ctx.source, `gen type "${type}": value and step must be numbers`, {
      hint: 'The `value` (start) and `step` attributes must be numeric, e.g. value="1" step="2".',
      code: 'TDC162',
    });
  }

  let current = start;
  const next = (): string => {
    const out = String(current);
    current = type === 'increment' ? current + step : current - step;
    return out;
  };
  ctx.state.inlineCounters.set(node, next);
  return next;
}
