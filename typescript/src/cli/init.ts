/**
 * `tdcv2 init` — create a config file, by asking rather than by making the user
 * hand-write JSON.
 *
 * The point (Nick's): people want to generate data, not learn a config format.
 * So in a real terminal this runs a short wizard — where should the config
 * live, where do downloaded packs go, what default locale — and writes the file
 * for you. With no terminal (a script, CI) it falls back to flags, so it stays
 * scriptable and testable.
 *
 * The wizard itself is a thin shell; the decisions it makes are pure functions
 * below, which is what the tests exercise. Inquirer is imported lazily so the
 * ordinary render path never pays for it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { PROJECT_CONFIG_NAME, globalConfigPath } from '../config/config.js';
import { EXAMPLES } from './examples.generated.js';

/**
 * The same text the other four implementations print, to the byte. `init` is
 * one command with five front ends, and a reader who checks the flags in one
 * of them must not find a different list in the next.
 */
const USAGE = `Usage: tdcv2 init [options]

  -g, --global          Write the per-user config instead of a project one
  -y, --yes             Take the defaults, ask nothing
  -f, --force           Overwrite an existing config
  --locale <loc>        Default locale for the config (default: en)
  --data-path <dir>     Folder for downloaded packs
`;

export interface InitPlan {
  /** Absolute path of the config file to write. */
  readonly path: string;
  /** Where downloaded packs should live — one folder, whatever is installed. */
  readonly packStore: string;
  /** Default locale. */
  readonly locale: string;
  /** True for the global (per-user) config, false for a project one. */
  readonly global: boolean;
}

export interface InitContext {
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Where the config file goes: project `./tdcv2.config.json`, or the global path. */
export function configTargetPath(global: boolean, ctx: InitContext): string {
  if (global) return globalConfigPath(ctx);
  return join(resolve(ctx.cwd), PROJECT_CONFIG_NAME);
}

/**
 * The default pack-store folder. A project keeps packs beside its config
 * (`./tdcv2-packs`); the global config keeps them next to itself
 * (`<config dir>/packs`), so everything for a user sits together.
 */
export function defaultPackStore(global: boolean, configPath: string, ctx: InitContext): string {
  if (!global) return join(resolve(ctx.cwd), 'tdcv2-packs');
  return join(dirname(configPath), 'packs');
}

/**
 * The config file's JSON. The store is written as `packStore` (NOT `dataPaths`):
 * it is where `pack add` downloads to, and it is not a scan root until there is
 * something in it — the first `pack add` registers the store itself, once, for
 * every bundle that will ever land there. A project config writes the store
 * RELATIVE (portable across machines and check-in-friendly); a global config
 * uses the absolute path (it is machine-specific by nature).
 */
export function buildConfigContent(plan: InitPlan): string {
  const store = plan.global ? plan.packStore : relativeTo(dirname(plan.path), plan.packStore);
  return `${JSON.stringify({ packStore: store, locale: plan.locale }, null, 2)}\n`;
}

/** A path relative to `from` if it is under it, else the absolute path. */
function relativeTo(from: string, target: string): string {
  const base = resolve(from);
  const abs = resolve(target);
  if (abs === base) return '.';
  if (abs.startsWith(base + '/')) return `./${abs.slice(base.length + 1)}`;
  return abs;
}

export class InitError extends Error {
  public override readonly name = 'InitError';
}

/**
 * Write the config (and create the pack-store folder). Refuses to clobber an
 * existing config unless `force`, so a second `init` does not silently wipe
 * settings.
 */
export function writeInitConfig(plan: InitPlan, opts: { force: boolean }): void {
  if (existsSync(plan.path) && !opts.force) {
    throw new InitError(
      `config already exists at "${plan.path}" — pass --force to overwrite, or edit it directly`,
    );
  }
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(plan.path, buildConfigContent(plan), 'utf8');
  mkdirSync(plan.packStore, { recursive: true }); // so the store exists for `pack add`
}

/** Where `init` puts the worked examples, beside the config it writes. */
export const EXAMPLES_DIR_NAME = 'tdcv2-examples';

/**
 * Write the worked examples next to the config, and return what was written.
 *
 * `init` used to leave a reader with a config file and no way to see output: it
 * printed "Next: run `tdcv2 pack`" and there was still no `.tdc` anywhere. Every
 * documented first command named a `demo.tdc` that nothing created, so the very
 * first command a newcomer typed could only fail.
 */
export function writeExamples(intoDir: string): readonly string[] {
  const target = join(intoDir, EXAMPLES_DIR_NAME);
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const example of EXAMPLES) {
    const to = join(target, example.name);
    // A second `init` must not overwrite an example someone has been editing.
    if (!existsSync(to)) writeFileSync(to, example.body, 'utf8');
    written.push(`${EXAMPLES_DIR_NAME}/${example.name}`);
  }
  return written;
}

interface InitFlags {
  readonly global: boolean;
  readonly force: boolean;
  readonly locale: string | undefined;
  readonly packStore: string | undefined;
  readonly yes: boolean;
}

function parseInitFlags(argv: readonly string[]): InitFlags {
  let global = false;
  let force = false;
  let yes = false;
  let locale: string | undefined;
  let packStore: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--global' || a === '-g') global = true;
    else if (a === '--force' || a === '-f') force = true;
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--locale') locale = argv[++i];
    else if (a?.startsWith('--locale=')) locale = a.slice('--locale='.length);
    else if (a === '--data-path') packStore = argv[++i];
    else if (a?.startsWith('--data-path=')) packStore = a.slice('--data-path='.length);
    else throw new InitError(`unknown option for init: ${String(a)}`);
  }
  return { global, force, locale, packStore, yes };
}

/** Run `tdcv2 init`. Returns a process exit code. */
export async function runInit(argv: readonly string[], ctx: InitContext): Promise<number> {
  // Before parsing: asking for help is not an option the parser has to accept,
  // and a user reaching for `--help` is usually already stuck on the rest of
  // the line. The other four implementations answer it here too.
  if (argv.some((a) => a === '-h' || a === '--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  let flags: InitFlags;
  try {
    flags = parseInitFlags(argv);
  } catch (err) {
    process.stderr.write(
      `tdcv2: ${(err as Error).message}\nRun \`tdcv2 init --help\` for usage.\n`,
    );
    return 2;
  }

  // isTTY is typed `boolean` but is `undefined` when not a terminal; either way
  // it is falsy off a TTY, which is what we want.
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !flags.yes;

  let plan: InitPlan;
  try {
    plan = interactive ? await askWizard(flags, ctx) : planFromFlags(flags, ctx);
  } catch (err) {
    // A wizard cancelled with Ctrl-C throws; treat as a clean abort.
    if (isPromptCancel(err)) {
      process.stderr.write('tdcv2: cancelled\n');
      return 1;
    }
    process.stderr.write(`tdcv2: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    writeInitConfig(plan, { force: flags.force });
  } catch (err) {
    process.stderr.write(`tdcv2: ${(err as Error).message}\n`);
    return 2;
  }

  // Examples land beside the config, which for a global init is the user's
  // home — not what anyone wants. A project init is the one that gets them.
  const examples = plan.global ? [] : writeExamples(dirname(plan.path));

  process.stdout.write(
    `Wrote ${plan.global ? 'global' : 'project'} config: ${plan.path}\n` +
      `  data packs → ${plan.packStore}\n` +
      `  locale     → ${plan.locale}\n` +
      (examples.length > 0 ? `  examples   → ${examples.join(', ')}\n` : '') +
      (examples.length > 0
        ? `\nNext: run it.\n    tdcv2 ${examples[0] ?? ''}\n` +
          `\nThe common, en and USA packs are already inside this install, so the\n` +
          `examples run with nothing downloaded. \`tdcv2 pack\` adds more locales.\n`
        : `\nNext: run \`tdcv2 pack\` to download data packs into that folder.\n`),
  );
  return 0;
}

/** Non-interactive plan: flags with defaults. */
function planFromFlags(flags: InitFlags, ctx: InitContext): InitPlan {
  const path = configTargetPath(flags.global, ctx);
  const packStore = flags.packStore
    ? resolve(ctx.cwd, flags.packStore)
    : defaultPackStore(flags.global, path, ctx);
  return { path, packStore, locale: flags.locale ?? 'en', global: flags.global };
}

/** The interactive wizard. Kept thin; the decisions are the pure functions. */
async function askWizard(flags: InitFlags, ctx: InitContext): Promise<InitPlan> {
  const { select, input } = await import('@inquirer/prompts');

  // If the user already scoped via flags, honour it; else ask.
  const global = flags.packStore
    ? flags.global
    : await select({
        message: 'Where should this config live?',
        choices: [
          { name: 'This project (a tdcv2.config.json here, check it into git)', value: false },
          { name: 'Global (all your projects, in your home folder)', value: true },
        ],
        default: flags.global,
      });

  const path = configTargetPath(global, ctx);
  const suggestedStore = flags.packStore
    ? resolve(ctx.cwd, flags.packStore)
    : defaultPackStore(global, path, ctx);

  const packStore = resolve(
    ctx.cwd,
    await input({ message: 'Folder for downloaded data packs?', default: suggestedStore }),
  );

  const locale = (
    await input({ message: 'Default locale?', default: flags.locale ?? 'en' })
  ).trim();

  return { path, packStore, locale: locale === '' ? 'en' : locale, global };
}

/** Inquirer throws an ExitPromptError on Ctrl-C; recognise it by name. */
function isPromptCancel(err: unknown): boolean {
  return err instanceof Error && err.name === 'ExitPromptError';
}
