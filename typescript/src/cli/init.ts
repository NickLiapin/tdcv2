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

export interface InitPlan {
  /** Absolute path of the config file to write. */
  readonly path: string;
  /** Where downloaded packs should live (a `dataPaths` entry). */
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
 * it is where `pack add` downloads bundles, and it is deliberately not a scan
 * root — `pack add` adds each bundle's own roots to `dataPaths` so addresses
 * stay correct. A project config writes the store RELATIVE (portable across
 * machines and check-in-friendly); a global config uses the absolute path (it
 * is machine-specific by nature).
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
  let flags: InitFlags;
  try {
    flags = parseInitFlags(argv);
  } catch (err) {
    process.stderr.write(`tdcv2: ${(err as Error).message}\n`);
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

  process.stdout.write(
    `Wrote ${plan.global ? 'global' : 'project'} config: ${plan.path}\n` +
      `  data packs → ${plan.packStore}\n` +
      `  locale     → ${plan.locale}\n` +
      `\nNext: run \`tdcv2 pack\` to download data packs into that folder.\n`,
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
