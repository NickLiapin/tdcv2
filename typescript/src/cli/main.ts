#!/usr/bin/env node
/**
 * Command-line entry point for TDC.
 *
 * Usage:
 *   tdcv2 <input.tdc> [-o <output>] [--seed <s>] [--count <n>] [--locale <loc>]
 *   tdcv2 --help
 *
 * With `-o` the generated content is written to the given path.
 * Without `-o` it is printed to stdout.
 *
 * This is a deliberately minimal CLI. The library API (`new TDC({...})`)
 * is the recommended embedding path; this CLI exists so users can run
 * TDC as a one-off against a standalone DSL file.
 */

import {
  closeSync,
  openSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { writeAllStringSync } from '../output/write-all.js';
import { runInit } from './init.js';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDateTimeStrict, toEpochMillis } from '../date/index.js';
import {
  type Diagnostic,
  TdcDiagnosticError,
  formatDiagnostic,
  formatDiagnostics,
} from '../errors/index.js';
import { formatTdc } from '../formatter/index.js';
import { TDC, WRITE_BATCH_BYTES } from '../lib/tdc.js';
import { parse } from '../parser/index.js';

import { parallelBlockReason, resolveJobCount, runParallel } from './parallel.js';
import { parquetJobLimit, runParquetParallel } from './parquet-parallel.js';
import { dataFileBytes, declaredSources, fitJobsToMemory } from './memory-budget.js';

interface CliArgs {
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly seed: string | undefined;
  readonly count: number | undefined;
  readonly locale: string | undefined;
  readonly now: number | undefined;
  readonly dataPaths: readonly string[];
  readonly stream: boolean;
  readonly mode: 'memory' | 'disk' | undefined;
  readonly engine: 1 | 2 | 3 | 4 | 5 | undefined;
  readonly jobs: number | undefined;
  readonly help: boolean;
  readonly version: boolean;
}

/**
 * Stdout sink, as an overridable object so tests can capture it (a direct
 * `fs.writeSync` can't be spied — its module export isn't configurable). We
 * write SYNCHRONOUSLY to fd 1: async `process.stdout.write` both races
 * `process.exit` (truncating large piped output) and buffers unboundedly with
 * a slow reader, which would break the streaming engine's O(1) memory.
 */
export const cliIo = {
  writeStdout(data: string): void {
    writeAllStringSync(1, data);
  },
};

const HELP = `tdcv2 — The Data Constructor

Usage:
  tdcv2 <input.tdc> [options]      Generate data from a config
  tdcv2 init [--global]            Set up a config (asks where; --yes for defaults)
  tdcv2 pack [list|add|remove <id>] Install / remove data packs (menu with no args)
  tdcv2 format [-w] <file.tdc>     Pretty-print a config (-w writes it in place)
  tdcv2 check [--brief] <input.tdc> Validate a config without generating anything
                                   (--brief: one line per diagnostic, no excerpt)

Options:
  -o, --output <path>      Write generated content to <path> (default: stdout)
  --seed <seed>            Override the seed declared in <env>
  --count <n>              Override the count declared in <env>
  --locale <loc>           Override the default locale (default: en)
  --now <date>             Pin the clock date generators read as "now" —
                           YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss, always UTC.
                           Without it the run reads the real clock, so a config
                           using today / now / b_day cannot be reproduced later
  --data-path <dir>        Add a data folder for @data/... sources (repeatable)
  --jobs <n>               Override the worker-thread count. By default TDC
                           auto-parallelizes big splittable files and stays
                           single-threaded otherwise — you need not set this.
                           Same output regardless (a pure speed knob)
  --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                           any size — TDC picks the streaming or exact engine
                           automatically from the config. memory: the small,
                           in-RAM engine (an escape hatch; does not scale)
  --disk                   Shortcut for --mode disk (already the default)
  --engine <1|2|3>         Advanced: force a specific engine
  --stream                 Legacy alias for --engine 2
  -h, --help               Show this message
  -v, --version            Show version and exit

Data paths also come from tdcv2.config.json (nearest one up from the .tdc file)
and ~/.config/tdcv2/config.json — { "dataPaths": [...], "locale": ".." }.
Order of priority: --data-path > project config > global config > bundled packs.

See https://github.com/NickLiapin/tdcv2 for the DSL reference.
`;

function parseArgs(argv: readonly string[]): CliArgs {
  let input: string | undefined;
  let output: string | undefined;
  let seed: string | undefined;
  let count: number | undefined;
  let locale: string | undefined;
  let now: number | undefined;
  const dataPaths: string[] = [];
  let stream = false;
  let mode: 'memory' | 'disk' | undefined;
  let engine: 1 | 2 | 3 | 4 | 5 | undefined;
  let jobs: number | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--output=')) {
      output = optionValue(a.slice('--output='.length), '--output');
      continue;
    }
    if (a?.startsWith('--seed=')) {
      seed = optionValue(a.slice('--seed='.length), '--seed');
      continue;
    }
    if (a?.startsWith('--count=')) {
      count = parseCount(optionValue(a.slice('--count='.length), '--count'));
      continue;
    }
    if (a?.startsWith('--locale=')) {
      locale = optionValue(a.slice('--locale='.length), '--locale');
      continue;
    }
    if (a?.startsWith('--now=')) {
      now = parseNow(optionValue(a.slice('--now='.length), '--now'));
      continue;
    }
    if (a?.startsWith('--data-path=')) {
      dataPaths.push(optionValue(a.slice('--data-path='.length), '--data-path'));
      continue;
    }
    if (a?.startsWith('--jobs=')) {
      jobs = parseJobs(optionValue(a.slice('--jobs='.length), '--jobs'));
      continue;
    }
    if (a?.startsWith('--engine=')) {
      engine = parseEngine(optionValue(a.slice('--engine='.length), '--engine'));
      continue;
    }
    if (a?.startsWith('--mode=')) {
      mode = parseMode(optionValue(a.slice('--mode='.length), '--mode'));
      continue;
    }

    switch (a) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '--stream':
        stream = true;
        break;
      case '--disk':
        mode = 'disk';
        break;
      case '--mode':
        i += 1;
        mode = parseMode(requiredNext(argv, i, a));
        break;
      case '-o':
      case '--output':
        i += 1;
        output = requiredNext(argv, i, a);
        break;
      case '--seed':
        i += 1;
        seed = requiredNext(argv, i, a);
        break;
      case '--count':
        i += 1;
        count = parseCount(requiredNext(argv, i, a));
        break;
      case '--locale':
        i += 1;
        locale = requiredNext(argv, i, a);
        break;
      case '--now':
        i += 1;
        now = parseNow(requiredNext(argv, i, a));
        break;
      case '--data-path':
        i += 1;
        dataPaths.push(requiredNext(argv, i, a));
        break;
      case '--jobs':
        i += 1;
        jobs = parseJobs(requiredNext(argv, i, a));
        break;
      case '--engine':
        i += 1;
        engine = parseEngine(requiredNext(argv, i, a));
        break;
      default:
        if (a?.startsWith('-')) {
          throw new Error(`unknown option: ${a}`);
        }
        if (input === undefined) input = a;
        else throw new Error(`unexpected positional argument: ${String(a)}`);
    }
  }

  return {
    input,
    output,
    seed,
    count,
    locale,
    now,
    dataPaths,
    stream,
    mode,
    engine,
    jobs,
    help,
    version,
  };
}

function requiredNext(argv: readonly string[], index: number, option: string): string {
  return optionValue(argv[index], option);
}

function optionValue(value: string | undefined, option: string): string {
  if (value === undefined || value === '') throw new Error(`missing value for ${option}`);
  return value;
}

function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`invalid --count "${value}" — expected a non-negative integer`);
  }
  return count;
}

function parseJobs(value: string): number {
  const jobs = Number(value);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`invalid --jobs "${value}" — expected a positive integer`);
  }
  return jobs;
}

/**
 * The wall clock is the one input to a run that the command line could not name,
 * which made `today`, `now` and `person.b_day` unreproducible: same config, same
 * seed, different day, different bytes.
 *
 * The syntax is the date generator's own — whatever `<gen type="date" value="…">`
 * accepts is what this accepts, down to the same parser — so the project has one
 * date syntax rather than two. It carries no zone, so like every date in the
 * engine it is read as UTC. A value that does not parse is refused here rather
 * than falling back to the real clock, which would hand back the very
 * irreproducibility the flag exists to remove.
 */
function parseNow(value: string): number {
  try {
    return toEpochMillis(parseDateTimeStrict(value).value);
  } catch {
    throw new Error(`invalid --now "${value}" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)`);
  }
}

function parseEngine(value: string): 1 | 2 | 3 | 4 | 5 {
  if (value === '1' || value === '2' || value === '3' || value === '4' || value === '5') {
    return Number(value) as 1 | 2 | 3 | 4 | 5;
  }
  throw new Error(
    `invalid --engine "${value}" — expected 1 (in-memory), 2 (streaming), ` +
      `3 (exact-on-disk), 4 or 5 (experimental)`,
  );
}

function parseMode(value: string): 'memory' | 'disk' {
  if (value === 'memory' || value === 'disk') return value;
  throw new Error(`invalid --mode "${value}" — expected "memory" or "disk"`);
}

/**
 * What to say when the config named on the command line is not there.
 *
 * Byte-identical in all five, because it is the same command with five front
 * ends and a reader who hits it in one must not get less help in the next.
 */
export function missingConfigMessage(file: string): string {
  return (
    `tdcv2: no config file at "${file}"\n` +
    `\n` +
    `  \`tdcv2 init\` writes a config and three worked examples into this folder,\n` +
    `  then prints the command that runs the first one.\n`
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'check') return runCheck(argv.slice(1));
  if (argv[0] === 'format') return runFormat(argv.slice(1));
  if (argv[0] === 'init') return runInit(argv.slice(1), { cwd: process.cwd() });
  if (argv[0] === 'pack') {
    const { runPack } = await import('./pack.js');
    return runPack(argv.slice(1), { cwd: process.cwd() });
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`tdcv2: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write('Run `tdcv2 --help` for usage.\n');
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.version) {
    // Dynamic import to avoid circular init and keep the CLI startup
    // cost bounded even when --help is requested.
    const { VERSION } = await import('../index.js');
    process.stdout.write(`tdcv2 ${VERSION}\n`);
    return 0;
  }

  if (!args.input) {
    process.stderr.write('tdcv2: input file is required\n');
    process.stderr.write('Run `tdcv2 --help` for usage.\n');
    return 2;
  }
  // Captured before the merge below reassigns `args` (which would lose the
  // narrowing that `input` is non-undefined here).
  const inputFile = args.input;

  // Checked here rather than left to the reader, because this is the first
  // error a newcomer can hit and it used to be the worst one in the product:
  // a raw `ENOENT: no such file or directory` with no code, no hint and no
  // mention of the command that would have created something to run. Every
  // documented first command named a file the docs created a hundred lines
  // later, so the very first thing a reader typed produced it.
  if (!existsSync(inputFile)) {
    process.stderr.write(missingConfigMessage(inputFile));
    return 1;
  }

  // The config cascade (global → project → --flags) is folded in by `TDC`
  // itself, not here, so that the library and `tdcv2 check` see the project's
  // packs too. What is left for the command line is what only the command line
  // knows: a relative `--data-path` was typed in THIS directory, so it resolves
  // against the shell rather than against the .tdc file.
  args = {
    ...args,
    dataPaths: args.dataPaths.map((p) => resolve(process.cwd(), p)),
  };

  try {
    const opts: {
      configFile: string;
      seed?: string;
      count?: number;
      locale?: string;
      now?: number;
      dataPaths?: readonly string[];
      stream?: boolean;
      mode?: 'memory' | 'disk';
      engine?: 1 | 2 | 3 | 4 | 5;
    } = { configFile: inputFile };
    if (args.seed !== undefined) opts.seed = args.seed;
    if (args.count !== undefined) opts.count = args.count;
    if (args.locale !== undefined) opts.locale = args.locale;
    if (args.now !== undefined) opts.now = args.now;
    if (args.dataPaths.length > 0) opts.dataPaths = args.dataPaths;
    if (args.stream) opts.stream = true;
    if (args.mode !== undefined) opts.mode = args.mode;
    if (args.engine !== undefined) opts.engine = args.engine;
    const tdc = new TDC(opts);
    // Surface non-fatal diagnostics (warnings) to stderr so the user
    // sees them before the output is written.
    if (tdc.diagnostics.length > 0) {
      const useColors = process.stderr.isTTY;
      process.stderr.write(
        formatDiagnostics(tdc.diagnostics, tdc.source, {
          filename: inputFile,
          colors: useColors,
        }) + '\n',
      );
    }

    // Reproducibility: when no seed was given (neither --seed nor
    // <env seed="…">), a random one is generated. Print it so a
    // successful generation can be reproduced later with --seed.
    const seedInfo = tdc.seedInfo();
    if (seedInfo.generated) {
      process.stderr.write(
        `tdcv2: no seed specified — using random seed "${seedInfo.seed}". ` +
          `Re-run with --seed "${seedInfo.seed}" to reproduce this exact output.\n`,
      );
    }

    // Memory preflight: bail early if the estimated run exceeds free RAM.
    // A warning is printed but doesn't abort; an error aborts before
    // rendering so the user doesn't wait hours for an OOM crash.
    const memoryDiag = tdc.preflight({ output: 'streaming' });
    if (memoryDiag) {
      const useColors = process.stderr.isTTY;
      process.stderr.write(
        formatDiagnostic(memoryDiag, tdc.source, {
          filename: inputFile,
          colors: useColors,
        }) + '\n',
      );
      if (memoryDiag.severity === 'error') return 1;
    }

    // Threads: AUTO by default — the program parallelizes when it pays off
    // (splittable config + a big enough file) and stays single-threaded
    // otherwise, so the user need not pass anything. An explicit --jobs is an
    // override. The job count never changes the output (a pure speed knob).
    // A .parquet output is one structured container, but it is built from ROW
    // GROUPS whose bytes do not depend on where they sit — only the footer
    // holds offsets. So workers can each build whole groups and the
    // coordinator lays them end to end and writes one footer. Splitting on a
    // group boundary (never mid-group) is what keeps the bytes identical to a
    // single-threaded run. Parquet to STDOUT stays single-threaded: the
    // coordinator needs to place groups at known offsets.
    const parquetOutput = (args.output ?? '').toLowerCase().endsWith('.parquet');
    const streamOk = tdc.usesSeekableEngine();
    const blockReason = streamOk ? parallelBlockReason(tdc.source) : undefined;
    const canParallelize =
      streamOk && blockReason === undefined && (!parquetOutput || !!args.output);
    // Only an EXPLICIT --jobs>1 that can't run warrants a note; auto stays quiet.
    if ((args.jobs ?? 0) > 1 && !canParallelize) {
      process.stderr.write(
        blockReason !== undefined
          ? `tdcv2: --jobs can't split this config: ${blockReason}. Running single-threaded.\n`
          : 'tdcv2: --jobs needs an engine that resolves each row on its own; this ' +
              'config uses the in-memory engine. Running single-threaded.\n',
      );
    }
    const requested = resolveJobCount({
      explicit: args.jobs,
      canParallelize,
      count: tdc.effectiveCount(),
      cores: availableParallelism(),
    });
    // Every worker re-parses the config's data files, so memory grows linearly
    // with the job count. Fit it to the machine rather than letting the run die
    // halfway — silently, because the person generating data may be an analyst
    // and a lecture about isolates helps nobody.
    const budget = fitJobsToMemory({
      jobs: requested,
      dataBytes: dataFileBytes(declaredSources(tdc.source), {
        ...(args.dataPaths.length > 0 ? { dataPaths: args.dataPaths } : {}),
      }),
    });
    const jobs = budget.jobs;
    // Only say something when the user ASKED for a number we could not give.
    if (budget.reduced && (args.jobs ?? 0) > 1) {
      process.stderr.write(
        `tdcv2: --jobs ${String(requested)} would not fit in memory with this data; using ${String(jobs)}.\n`,
      );
    }
    if (jobs > 1 && canParallelize) {
      await (parquetOutput
        ? renderParquetParallel(tdc, args, jobs)
        : renderParallel(tdc, args, jobs));
      return 0;
    }

    // A `type="http"` generator makes a network call, so this config renders on
    // the async path. It is Engine-1 only (materialised in memory anyway), so a
    // whole-output render costs nothing extra over the streaming path here.
    if (tdc.usesHttp()) {
      // The extension decides the CONTAINER here exactly as it does on the
      // synchronous path. Writing the text rendering to `-o out.parquet` and
      // exiting 0 was the one failure nothing downstream could catch.
      if (args.output) await tdc.writeFileAsync(args.output);
      else cliIo.writeStdout(await tdc.toStringAsync());
      return 0;
    }

    // Streaming output: iterate chunk-by-chunk and write as we go. Keeps
    // process memory bounded by the largest single card plus the
    // sequence registry, instead of holding the whole output in memory.
    if (args.output) {
      tdc.writeFile(args.output);
    } else {
      // Batch cards into ~1 MB buffers, written SYNCHRONOUSLY to stdout (fd 1).
      // One `write` per card is one syscall per row; and async
      // `process.stdout.write` would race `process.exit` and truncate output.
      let buf = '';
      for (const chunk of tdc.toIterator()) {
        buf += chunk;
        if (buf.length >= WRITE_BATCH_BYTES) {
          cliIo.writeStdout(buf);
          buf = '';
        }
      }
      if (buf.length > 0) cliIo.writeStdout(buf);
    }
    return 0;
  } catch (err) {
    if (err instanceof TdcDiagnosticError) {
      const useColors = process.stderr.isTTY;
      process.stderr.write(
        formatDiagnostics(err.diagnostics, err.source, {
          filename: inputFile,
          colors: useColors,
        }) + '\n',
      );
      return 1;
    }
    process.stderr.write(`tdcv2: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/**
 * `tdcv2 check <file.tdc>` — the validator alone, for an editor or a pre-commit
 * hook. Nothing goes to stdout: a hook's stdout is noise, and a caller that
 * wants the data runs the generator instead. Exit 0 when the config is usable,
 * 1 when it is not.
 */
function runCheck(argv: readonly string[]): number {
  // `--brief` prints one line per diagnostic and no source excerpt. The full
  // report is right for a person and wrong for a program: an editor listing
  // errors in a panel wants rows, and a tool feeding a refusal back to a model
  // spends two thirds of its window on the picture of the file.
  const brief = argv.includes('--brief');
  const files = argv.filter((a) => !a.startsWith('-'));
  const flags = argv.filter((a) => a.startsWith('-'));
  if (flags.some((f) => f !== '--brief') || files.length !== 1) {
    process.stderr.write('tdcv2: usage: tdcv2 check [--brief] <input.tdc>\n');
    return 2;
  }
  const file = files[0] ?? '';

  try {
    const tdc = new TDC({ configFile: file });
    if (tdc.diagnostics.length > 0) {
      process.stderr.write(
        formatDiagnostics(tdc.diagnostics, tdc.source, {
          filename: file,
          colors: process.stderr.isTTY,
          brief,
        }) + '\n',
      );
    } else {
      process.stderr.write(`tdcv2: ${file} is valid\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof TdcDiagnosticError) {
      process.stderr.write(
        formatDiagnostics(err.diagnostics, err.source, {
          filename: file,
          colors: process.stderr.isTTY,
          brief,
        }) + '\n',
      );
      return 1;
    }
    process.stderr.write(`tdcv2: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/**
 * `tdcv2 format [-w] <file.tdc>` — pretty-print a config. Prints to stdout by
 * default; `-w`/`--write` overwrites the file in place. A file with a syntax
 * error is reported (never reformatted) and exits 1.
 */
function runFormat(argv: readonly string[]): number {
  let file: string | undefined;
  let write = false;
  for (const a of argv) {
    if (a === '-w' || a === '--write') {
      write = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: tdcv2 format [-w|--write] <file.tdc>\n');
      return 0;
    }
    if (a.startsWith('-')) {
      process.stderr.write(`tdcv2 format: unknown option: ${a}\n`);
      return 2;
    }
    if (file === undefined) file = a;
    else {
      process.stderr.write(`tdcv2 format: unexpected argument: ${a}\n`);
      return 2;
    }
  }
  if (file === undefined) {
    process.stderr.write('tdcv2 format: a .tdc file is required\n');
    return 2;
  }

  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(
      `tdcv2 format: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  // Never format a file we can't fully parse — report the syntax error instead.
  const parsed = parse(source);
  if (parsed.diagnostics.length > 0) {
    // TDC001, the same code a parse failure carries on the generate path. Without it `format`
    // and a plain run reported the same broken file two different ways.
    const diags: Diagnostic[] = parsed.diagnostics.map((d) => ({
      severity: 'error',
      source: d.source,
      code: 'TDC001',
      line: d.line,
      column: d.column,
      message: d.message,
    }));
    process.stderr.write(
      formatDiagnostics(diags, source, { filename: file, colors: process.stderr.isTTY }) + '\n',
    );
    return 1;
  }

  const formatted = formatTdc(source);
  if (write) {
    if (formatted !== source) {
      // Write beside the file and rename over it: a crash mid-write must not
      // leave the user's config truncated.
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, formatted);
      renameSync(tmp, file);
      process.stderr.write(`tdcv2: formatted ${file}\n`);
    } else {
      process.stderr.write(`tdcv2: ${file} is already formatted\n`);
    }
  } else {
    cliIo.writeStdout(formatted);
  }
  return 0;
}

/**
 * Run parallel generation with a pre-resolved worker count. The caller has
 * already confirmed the config can be split (streaming engine, no inline
 * render-time generators) and that `jobs > 1`. Output is byte-identical to a
 * single-threaded run.
 */
async function renderParallel(tdc: TDC, args: CliArgs, jobs: number): Promise<void> {
  // From the TDC instance, not from `args`: the instance has already folded in
  // the project config, so its locale, its data paths and its base directory
  // are the ones the single-threaded run would have used. Reading `args` here
  // instead is what made a parallel run silently differ from a serial one.
  const params = {
    ...tdc.workerOptions(),
    now: args.now ?? Date.now(),
    jobs,
    // Engine 4 splits the duplicate hunt into piles as well as the scan; the
    // coordinator is where that is arranged, so it has to be told.
    engine: tdc.engineId(),
  };
  if (args.output) {
    const fd = openSync(args.output, 'w');
    try {
      await runParallel({ ...params, destFd: fd });
    } finally {
      closeSync(fd);
    }
  } else {
    await runParallel({ ...params, destFd: 1 });
  }
}

/**
 * Parallel Parquet: workers build whole row groups, the coordinator writes the
 * magic, concatenates the groups in order, and closes with one footer holding
 * the corrected offsets. Requires a real output file — the footer has to name
 * where each group landed.
 */
async function renderParquetParallel(
  tdc: TDC,
  args: { output?: string | undefined; now?: number | undefined },
  jobs: number,
): Promise<void> {
  const now = args.now ?? Date.now();
  // From the instance, like the text path: the command line does not know what
  // the project config added.
  const worker = tdc.workerOptions();
  const params = {
    ...worker,
    now,
    // Never more workers than there are groups to hand out.
    jobs: parquetJobLimit(worker.source, jobs, now, worker.seed),
  };
  const fd = openSync(args.output ?? '', 'w');
  try {
    await runParquetParallel({ ...params, destFd: fd });
  } finally {
    closeSync(fd);
  }
}

export function isDirectInvocation(
  invokedPath: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!invokedPath) return false;
  const modulePath = fileURLToPath(moduleUrl);
  const resolvedInvoked = resolve(invokedPath);
  const resolvedModule = resolve(modulePath);
  try {
    return realpathSync(resolvedInvoked) === realpathSync(resolvedModule);
  } catch {
    return resolvedInvoked === resolvedModule;
  }
}

// Run when invoked directly, not when imported.
if (isDirectInvocation()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`tdcv2: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
