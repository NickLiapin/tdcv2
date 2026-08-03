/**
 * `--help` for the subcommands.
 *
 * `tdcv2 --help` was always answered; `tdcv2 init --help` and `tdcv2 pack -h`
 * were not — init read `--help` as an option it did not know and pack read `-h`
 * as a subcommand, so both exited 2 with a complaint about the flag the user had
 * reached for BECAUSE they were already stuck. The other four implementations
 * print the usage and exit 0, and the docs claim all five behave alike.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runInit } from '../../src/cli/init.js';
import { runPack } from '../../src/cli/pack.js';

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tdchelp-'));

/**
 * A directory with no config of any kind — home points at it too, so the
 * developer's own global config cannot make a case pass that would fail on a
 * fresh machine.
 */
const ctx = (
  dir: string,
): { cwd: string; home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv } => ({
  cwd: dir,
  home: dir,
  platform: 'linux',
  env: {},
});

describe('tdcv2 init --help', () => {
  it.each(['--help', '-h'])('prints the usage and exits 0 for %s', async (flag) => {
    expect(await runInit([flag], ctx(tmp()))).toBe(0);
    expect(stdout).toContain('Usage: tdcv2 init [options]');
    expect(stdout).toContain('-g, --global');
    expect(stdout).toContain('--data-path <dir>');
    expect(stderr).toBe('');
  });

  it('answers help even when the rest of the line is wrong', async () => {
    // The case that sends people to --help in the first place.
    expect(await runInit(['--nonsense', '--help'], ctx(tmp()))).toBe(0);
    expect(stdout).toContain('Usage: tdcv2 init [options]');
  });

  it('points at --help when an option is not understood', async () => {
    expect(await runInit(['--nonsense'], ctx(tmp()))).toBe(2);
    expect(stderr).toContain('unknown option for init: --nonsense');
    expect(stderr).toContain('Run `tdcv2 init --help` for usage.');
  });
});

describe('tdcv2 pack --help', () => {
  it.each(['--help', '-h'])('prints the usage and exits 0 for %s', async (flag) => {
    // Deliberately in a directory `init` has never run in: help is the one
    // thing that must work before there is a pack store to resolve.
    expect(await runPack([flag], ctx(tmp()))).toBe(0);
    expect(stdout).toContain('Usage: tdcv2 pack [command]');
    expect(stdout).toContain('add <id>...');
    expect(stdout).toContain('--registry <url>');
    expect(stderr).toBe('');
  });

  it('does not read -h as a subcommand', async () => {
    // With a store already configured the argument parser gets as far as
    // treating `-h` as the command name, which is where `unknown pack command
    // "-h"` came from.
    const dir = tmp();
    writeFileSync(
      join(dir, 'tdcv2.config.json'),
      JSON.stringify({ packStore: './tdcv2-packs', locale: 'en' }),
    );
    expect(await runPack(['-h'], ctx(dir))).toBe(0);
    expect(stderr).not.toContain('unknown pack command');
  });
});
