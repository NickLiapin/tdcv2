/**
 * Public library API — the `TDC` class.
 *
 * This is the user-facing facade described in docs/vision/17-library-api.md:
 * construct with either `configFile` or `configString` plus optional runtime
 * overrides, then pick a terminal operation:
 *
 *   - `writeFile(path)` — render the configured output and write it to `path`
 *     (Node-only; uses `node:fs`).
 *   - `toString()` — render and return the output as a single string.
 *   - `toIterator()` — yield one text row per iteration for streaming.
 *   - `toStream()` — expose text output as a Node.js Readable stream.
 *   - `toArray()` / `iterate()` / `getAt()` — expose materialised
 *     sequences as plain objects, ignoring text-output wrappers.
 *
 * Evaluation is lazy: the constructor parses and stores the tree, but
 * rendering happens only when a terminal is invoked. The same TDC
 * instance may be terminal-invoked multiple times; results are
 * deterministic per (config, seed, now).
 */

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { loadConfig } from '../config/config.js';
import {
  type PackRegistry,
  bundledPacksDir,
  packParameterNames,
  scanPacks,
} from '../data-pack/index.js';
import { type Diagnostic, TdcDiagnosticError, hasErrors } from '../errors/index.js';
import { estimateMemoryUsage, memoryWarning } from '../errors/memory-estimate.js';
import type { DocumentContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { renderParquetChunks } from '../output/render-parquet.js';
import { parse } from '../parser/index.js';
import { extractAttrs, findChildElement, elementKind, elementName } from '../processor/walk.js';
import {
  render,
  renderAsync,
  renderStream,
  resolveEngineSelection,
  resolveRenderEngine,
  specsUseHttp,
} from '../processor/render.js';
import { extractEnvUniqGroups, extractSequenceSpecs } from '../sequence/index.js';
import { validate } from '../validator/index.js';

import {
  getObjectRowAt,
  iterateObjectRows,
  materializeObjectRows,
  type TdcObjectRow,
} from './object.js';

/**
 * Batch size for streaming writes. One write per card is one syscall per row;
 * accumulating ~1 MB before flushing cuts that by ~1000× while keeping peak
 * memory bounded (the buffer, not the whole output).
 */
export const WRITE_BATCH_BYTES = 1 << 20;

export interface TdcOptions {
  /** Path to a DSL file on disk (preferred for larger configs). */
  readonly configFile?: string;
  /** Inline DSL source string (preferred for small / dynamic configs). */
  readonly configString?: string;
  /** Override the seed declared in `<env seed="...">`. */
  readonly seed?: string;
  /** Override the count declared in `<env count="...">`. */
  readonly count?: number;
  /** Override the default locale — beats what `<env local="…">` declares. */
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

  /** Freeze the "now" clock used by date-based templates (ms since epoch). */
  readonly now?: number;
  /** Base directory for relative data-source `src` paths. */
  readonly baseDir?: string;
  /** Extra folders searched by `src="@data/..."` and relative file sources. */
  readonly dataPaths?: readonly string[];
  /** Legacy: force the streaming (Engine 2) engine. Prefer `mode`. */
  readonly stream?: boolean;
  /** User mode: "memory" (Engine 1) or "disk" (Engine 2/3 auto). Overrides `<env mode>`. */
  readonly mode?: 'memory' | 'disk';
  /** Advanced: force a specific engine (1/2/3). Highest precedence. */
  readonly engine?: 1 | 2 | 3;
}

export interface TdcPreflightOptions {
  /**
   * `materialized` matches `toString()` and includes the full output string
   * in the estimate. `streaming` matches `toIterator()`, `toStream()`,
   * `writeFile()`, and the CLI; sequence arrays are still materialized.
   */
  readonly output?: 'materialized' | 'streaming';
}

export class TDC {
  private readonly tree: DocumentContext;
  private readonly options: TdcOptions;
  private readonly baseDir: string;
  /**
   * Original DSL source. Exposed so callers can pass it to
   * `formatDiagnostics` if they catch `TdcDiagnosticError` later on —
   * rare in practice (the constructor already throws on errors) but
   * useful when consuming warnings via `diagnostics`.
   */
  public readonly source: string;
  /**
   * Every diagnostic produced by the parser + validator, including
   * non-fatal warnings (which are not thrown). Callers can surface
   * these to a log / editor / CLI stderr.
   */
  public readonly diagnostics: readonly Diagnostic[];
  /**
   * Effective seed, resolved once and cached so every terminal
   * (`toString`, `toIterator`, `writeFile`, …) uses the SAME seed and
   * produces identical output. Populated lazily by `seedInfo()`.
   */
  private cachedSeed?: { readonly seed: string; readonly generated: boolean };
  /** Loaded data-pack registry (address -> list). Empty when no packs. */
  private readonly packs: PackRegistry;

  public constructor(options: TdcOptions) {
    const resolved = resolveSource(options);
    const source = resolved.source;
    const parseResult = parse(source);

    // The project's `tdcv2.config.json`, folded in HERE rather than in the
    // command line, so that a pack installed by `tdcv2 pack add` is found by
    // `new TDC(...)` and by `tdcv2 check` too — not only by `tdcv2 <file>`.
    // Java, Python and C# have always read it from the library, and a pack the
    // other three could see and this one could not is the kind of difference
    // that only shows up as missing data.
    //
    // Searched from the CONFIG FILE's directory: a `.tdc` file belongs to the
    // project it sits in, not to the shell that happened to invoke it. With a
    // config string there is no file, so the working directory is the only
    // honest answer left.
    const effective = withProjectConfig(options, resolved.baseDir);

    // Load data packs before validation so pack addresses are accepted as
    // valid `template` values. Roots: the bundled pack folder plus any
    // user `--data-path` / `dataPaths` directories.
    const packRoots = [bundledPacksDir(), ...(effective.dataPaths ?? [])].filter(
      (p): p is string => p !== undefined,
    );
    const packScan = scanPacks(packRoots);
    this.packs = packScan.registry;

    const parserDiags: Diagnostic[] = parseResult.diagnostics.map((d, i) => ({
      severity: 'error',
      source: d.source,
      // The same code `format` gives a parse failure. It was missing here, and
      // the shared CLI fixture — which requires a located, CODED diagnostic —
      // was satisfied instead by the TDC002 that the torn tree produced. A
      // contract met by the very fallout it was meant to rule out.
      code: 'TDC001',
      line: d.line,
      column: d.column,
      message: d.message,
      ...(i === 0
        ? {
            hint: 'The document did not parse, so the structural and semantic checks were skipped. Fix this first — anything they reported would be describing the torn tree, not your config.',
          }
        : {}),
    }));

    // A tree that did not parse makes every later finding suspect, so none are
    // shown. An unpaired `</gen>` drops <block> out of the document, and the run
    // then reported "no <block> child" about a <block> plainly present in the
    // very line it printed — the consequence reading as more convincing than the
    // cause, and both a reader and a model going off to fix the wrong thing.
    if (parserDiags.length > 0) {
      throw new TdcDiagnosticError(parserDiags, source);
    }

    const validation = validate(parseResult.tree, {
      dataSources: { baseDir: resolved.baseDir, dataPaths: effective.dataPaths },
      packAddresses: [...this.packs.keys()],
      packParams: packParameterNames(this.packs),
    });
    const combined: Diagnostic[] = [...packScan.diagnostics, ...validation.diagnostics];
    if (hasErrors(combined)) {
      throw new TdcDiagnosticError(combined, source);
    }
    this.tree = parseResult.tree;
    this.options = effective;
    this.baseDir = resolved.baseDir;
    this.source = source;
    this.diagnostics = combined;
  }

  /** Render and return the complete textual output. */
  public toString(): string {
    return render(this.tree, this.renderOptions());
  }

  /**
   * Whether this config contains a `type="http"` generator, which makes a
   * network call and so can only be rendered on the async path
   * ({@link toStringAsync}). The CLI checks this to pick the right path.
   */
  public usesHttp(): boolean {
    const envEl = findEnv(this.tree);
    return specsUseHttp(extractSequenceSpecs(envEl));
  }

  /**
   * Async render — required when the config uses a `type="http"` generator,
   * identical to {@link toString} otherwise. The result is non-deterministic
   * when http is used: re-running does not reproduce.
   */
  public toStringAsync(): Promise<string> {
    return renderAsync(this.tree, this.renderOptions());
  }

  /**
   * Check whether the configured run might run out of memory.
   *
   * The estimate is rough: it assumes typical short-string cells and
   * typical per-card output size. For unusual configs (e.g. a single
   * huge templated string per card) the real usage may differ. The
   * function is fast — it does not actually run the render.
   *
   * Returns a diagnostic when the estimate is a large share of, or above,
   * the machine's TOTAL RAM (not the OS's instantaneous free number, which
   * under-reports usable memory — see `memory-estimate.ts`). Returns
   * `undefined` when the run is comfortably safe. Callers (CLI) typically
   * print the diagnostic and, when severity is 'error', abort before
   * rendering.
   */
  public preflight(options: TdcPreflightOptions = {}): Diagnostic | undefined {
    const cardCount = this.resolveCount();
    const sequenceSlots = this.countSequenceSlots();
    // Engines 2 (streaming) and 3 (exact-on-disk) are both bounded-memory —
    // they don't materialise the registry — so a huge count is not a RAM risk
    // for them. Only Engine 1 scales memory with count.
    const estimate = estimateMemoryUsage(cardCount, sequenceSlots, {
      output: options.output ?? 'materialized',
      engine: this.resolveEngine() === 1 ? 'memory' : 'stream',
    });
    return memoryWarning(estimate);
  }

  /**
   * Whether this run uses Engine 2 (streaming). True when `{ stream: true }`
   * was passed (CLI `--stream`) or `<env mode="stream">` is declared. Engine 2
   * is O(#sequence slots) memory, so a huge `count` is not a memory risk.
   */
  private isStreamEngine(): boolean {
    return this.resolveEngine() === 2;
  }

  /**
   * Which engine this run uses (1 in-memory, 2 streaming, 3 exact-on-disk),
   * resolved with the same precedence + disk-mode routing as the renderer.
   */
  private resolveEngine(): 1 | 2 | 3 {
    const envEl = findEnv(this.tree);
    const attrs = envEl ? extractAttrs(envEl.attr()) : {};
    const selection = resolveEngineSelection(attrs, {
      engine: this.options.engine,
      stream: this.options.stream,
      mode: this.options.mode,
    });
    // Ask the RENDERER's router rather than deciding again here.
    //
    // This used to be a second implementation that only chose between 3 and 2,
    // while claiming in its own comment to match the renderer. It did not: the
    // renderer sends five shapes to Engine 1 — a template address that
    // interpolates a field, weight= with row=, a percent-declaring pack
    // generator, uniq on a simple sequence, and http — and none of them were
    // asked about here.
    //
    // The cost of that was not cosmetic. `usesStreamEngine()` answered "yes"
    // for a config the renderer runs in memory, so the CLI believed the run was
    // parallelisable, and auto-parallelism (100,000 rows and up) hands each
    // worker `stream: true` — a FORCED engine, which has no fallback. Measured
    // before this fix: the same weight=+row= config produced 50,000 rows and
    // then, at 100,000, exited 1 with zero rows and a message telling the reader
    // to "run without a forced streaming engine" they had never asked for.
    return resolveRenderEngine(
      selection,
      extractSequenceSpecs(envEl),
      extractEnvUniqGroups(envEl),
      this.packs,
      this.options.locale,
    );
  }

  /** Resolved card count (CLI/API override beats env). Public for the parallel CLI. */
  public effectiveCount(): number {
    return this.resolveCount();
  }

  /** Whether this run uses Engine 2 (streaming) — required for parallel generation. */
  public usesStreamEngine(): boolean {
    return this.isStreamEngine();
  }

  /** Resolved card count — CLI/API override beats env, env beats default. */
  private resolveCount(): number {
    if (this.options.count !== undefined) return this.options.count;
    const envEl = findEnv(this.tree);
    if (envEl) {
      const attrs = extractAttrs(envEl.attr());
      const raw = attrs['count'];
      if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return 10; // same default render.ts uses
  }

  /**
   * Count how many entries the sequence registry will have: every
   * simple sequence contributes 1, every compound sequence contributes
   * one entry per field, plus the 4 built-ins.
   */
  private countSequenceSlots(): number {
    const envEl = findEnv(this.tree);
    const specs = extractSequenceSpecs(envEl);
    let slots = 4; // _count, _first, _last, _total
    for (const spec of specs) {
      if (spec.gens) slots += spec.gens.length;
      else slots += 1;
    }
    return slots;
  }

  /**
   * Render and write the textual output to disk.
   *
   * This is the streaming variant — chunks are written as they're
   * produced, so peak memory stays bounded regardless of `count`. The
   * file extension is for the caller's convenience only; the output
   * format is determined by the DSL (see docs/vision/04-output-formats.md).
   */
  public writeFile(path: string): void {
    // A binary, typed container is chosen by the file extension: the columns
    // come from the named <data> in the block, so the same config yields text
    // or Parquet depending only on where you point the output.
    if (path.toLowerCase().endsWith('.parquet')) {
      // Chunk-by-chunk, like the text path: one row group is held at a time.
      const pq = openSync(path, 'w');
      try {
        for (const chunk of renderParquetChunks(this.tree, this.renderOptions())) {
          writeSync(pq, chunk);
        }
      } finally {
        closeSync(pq);
      }
      return;
    }
    // Synchronous file descriptor lets us stream chunks without
    // buffering the full output, while keeping the call itself
    // synchronous (the classic behaviour callers expect). We use the
    // low-level `writeSync` rather than `createWriteStream` because
    // the latter flushes asynchronously — callers reading the file
    // right after `writeFile()` would race against the flush.
    const fd = openSync(path, 'w');
    try {
      // Batch cards into ~1 MB buffers before writing: one `writeSync` per
      // card is one syscall per row (millions of them). Peak memory stays
      // bounded by the batch size, not the output length.
      let buf = '';
      for (const chunk of this.toIterator()) {
        buf += chunk;
        if (buf.length >= WRITE_BATCH_BYTES) {
          writeSync(fd, buf);
          buf = '';
        }
      }
      if (buf.length > 0) writeSync(fd, buf);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Stream the output in chunks. Each yielded string is either a
   * fixture block (before / after the main loop) or one full rendered
   * card. Memory stays bounded by the largest single card plus the
   * pre-materialised sequence registry — the whole output string is
   * never held at once.
   *
   * Concatenation of all yielded chunks equals `toString()` byte for
   * byte.
   */
  public *toIterator(): Generator<string, void, void> {
    yield* renderStream(this.tree, this.renderOptions());
  }

  /**
   * Return text output as a Node.js Readable stream.
   *
   * The stream is backed by a fresh `toIterator()` call, so every terminal
   * invocation remains deterministic and independent. This is the ergonomic
   * API for `tdc.toStream().pipe(fs.createWriteStream(...))`.
   */
  public toStream(): Readable {
    return Readable.from(this.toIterator(), { objectMode: false });
  }

  /**
   * Return generated rows as plain objects keyed by sequence name.
   *
   * This mode ignores <block>/<line>/<data> output wrappers. Simple
   * sequences become scalar properties, compound sequences become nested
   * objects, and parent-filtered rows use `undefined` for values that do
   * not apply to the current card.
   */
  public toArray(): TdcObjectRow[] {
    return materializeObjectRows(this.tree, this.renderOptions());
  }

  /** Stream object rows one by one. */
  public *iterate(): Generator<TdcObjectRow, void, void> {
    yield* iterateObjectRows(this.tree, this.renderOptions());
  }

  /** Return one object row by zero-based index. */
  public getAt(index: number): TdcObjectRow {
    return getObjectRowAt(this.tree, index, this.renderOptions());
  }

  /**
   * Resolve the effective seed and report whether it was auto-generated.
   *
   * Priority: explicit `seed` option (CLI/API) → `<env seed="…">` in the
   * DSL → a freshly generated random seed. The result is cached so every
   * render terminal reuses it — this is what makes a seedless config
   * reproducible: the CLI prints the generated seed, and passing it back
   * as `--seed` reproduces the exact output.
   *
   * `generated` is true only in the third case (nothing was specified),
   * which is the signal the CLI uses to tell the user which seed to
   * record.
   */
  public seedInfo(): { readonly seed: string; readonly generated: boolean } {
    if (this.cachedSeed) return this.cachedSeed;
    let resolved: { readonly seed: string; readonly generated: boolean };
    if (this.options.seed !== undefined) {
      resolved = { seed: this.options.seed, generated: false };
    } else {
      const envEl = findEnv(this.tree);
      const envSeed = envEl ? extractAttrs(envEl.attr())['seed'] : undefined;
      resolved =
        envSeed !== undefined
          ? { seed: envSeed, generated: false }
          : { seed: String(Math.random()), generated: true };
    }
    this.cachedSeed = resolved;
    return resolved;
  }

  private renderOptions(): {
    seed?: string;
    count?: number;
    locale?: string;
    defaultLocale?: string;
    now?: number;
    stream?: boolean;
    mode?: 'memory' | 'disk';
    engine?: 1 | 2 | 3;
    baseDir?: string;
    dataPaths?: readonly string[];
    source?: string;
    packs?: PackRegistry;
  } {
    const r: {
      seed?: string;
      count?: number;
      locale?: string;
      defaultLocale?: string;
      now?: number;
      stream?: boolean;
      mode?: 'memory' | 'disk';
      engine?: 1 | 2 | 3;
      baseDir?: string;
      dataPaths?: readonly string[];
      source?: string;
      packs?: PackRegistry;
    } = {
      baseDir: this.baseDir,
      source: this.source,
      seed: this.seedInfo().seed,
      packs: this.packs,
    };
    if (this.options.count !== undefined) r.count = this.options.count;
    if (this.options.locale !== undefined) r.locale = this.options.locale;
    if (this.options.defaultLocale !== undefined) r.defaultLocale = this.options.defaultLocale;
    if (this.options.now !== undefined) r.now = this.options.now;
    if (this.options.stream !== undefined) r.stream = this.options.stream;
    if (this.options.mode !== undefined) r.mode = this.options.mode;
    if (this.options.engine !== undefined) r.engine = this.options.engine;
    if (this.options.dataPaths !== undefined) r.dataPaths = this.options.dataPaths;
    return r;
  }
}

function resolveSource(options: TdcOptions): { readonly source: string; readonly baseDir: string } {
  if (options.configString !== undefined && options.configFile !== undefined) {
    throw new Error('TDC: pass either configString or configFile, not both');
  }
  if (options.configString !== undefined) {
    return { source: options.configString, baseDir: resolve(options.baseDir ?? process.cwd()) };
  }
  if (options.configFile !== undefined) {
    const file = resolve(options.configFile);
    return {
      source: readFileSync(file, 'utf8'),
      baseDir: resolve(options.baseDir ?? dirname(file)),
    };
  }
  throw new Error('TDC: either configString or configFile must be provided');
}

/**
 * The options, plus whatever the project's `tdcv2.config.json` cascade adds.
 *
 * `dataPaths` accumulate config-then-caller, so a folder named at the call site
 * shadows one written down for every run. `locale` from the cascade becomes the
 * DEFAULT, never an override: folding it into `locale` made a config that says
 * `local="ru"` produce English whenever a config file existed — which `init`
 * always writes — and a run that succeeds with the wrong data is worse than one
 * that fails.
 */
function withProjectConfig(options: TdcOptions, baseDir: string): TdcOptions {
  const cfg = loadConfig({ cwd: process.cwd(), searchFrom: baseDir });
  const paths = [...cfg.dataPaths, ...(options.dataPaths ?? [])];
  const merged: { -readonly [K in keyof TdcOptions]: TdcOptions[K] } = { ...options };
  if (paths.length > 0) merged.dataPaths = paths;
  if (merged.defaultLocale === undefined && cfg.locale !== undefined) {
    merged.defaultLocale = cfg.locale;
  }
  return merged;
}

/** Find the <env> element inside the document's <tdc> root, if any. */
function findEnv(tree: DocumentContext): OpenCloseElementContext | undefined {
  for (const el of tree.element()) {
    const k = elementKind(el);
    if (k?.kind !== 'open') continue;
    if (elementName(k.node) !== 'tdc') continue;
    return findChildElement(k.node.content(), 'env');
  }
  return undefined;
}
