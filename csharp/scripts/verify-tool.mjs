#!/usr/bin/env node
/**
 * Install the command line the way a stranger installs it, and run it.
 *
 * `Tdcv2.Cli` is a second package, and it has to be: NuGet has no equivalent of
 * npm's `bin` or pip's console scripts, so a .NET tool is its own package kind.
 * Which means it can be broken in ways the library package is not — most
 * obviously by carrying no data. The library embeds the starter packs into
 * Tdcv2.dll, and the tool bundles that dll, so the data rides along; nothing in
 * the test suite would notice if that stopped being true, because every test
 * runs inside the repository where `data/packs` is a few directories up.
 *
 * So this packs the tool, installs it from a local feed into a directory OUTSIDE
 * the repository, runs `tdcv2` there as an installed command, and compares the
 * output with the TypeScript reference.
 *
 *   node scripts/verify-tool.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(projectDir, '..');
const feed = join(projectDir, 'Tdcv2.Cli.Tool', 'bin', 'Release');

/** Three packs, three shapes: a plain list, a check-digited id, a composed one. */
const CONFIG =
  '<tdc><env count="3" seed="tool-check" local="en">' +
  '<sequence name="Name"><gen type="template" value="person.lastName"/></sequence>' +
  '<sequence name="Ssn"><gen type="template" value="usa.docs.ssn"/></sequence>' +
  '<sequence name="Iban"><gen type="template" value="common.finance.iban"/></sequence></env>' +
  '<block><line><data>${{Name}} | ${{Ssn}} | ${{Iban}}</data></line></block></tdc>';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

// Somewhere with no repository above it.
const work = mkdtempSync(join(tmpdir(), 'tdcv2-tool-'));
const toolPath = join(work, 'tools');

try {
  console.log('staging the starter packs…');
  run('node', [join(projectDir, 'scripts', 'bundle-packs.mjs'), 'add'], { cwd: projectDir });

  console.log('packing the tool…');
  rmSync(feed, { recursive: true, force: true });
  run(
    'dotnet',
    ['pack', join(projectDir, 'Tdcv2.Cli.Tool', 'Tdcv2.Cli.Tool.csproj'), '-c', 'Release', '-v', 'q', '--nologo'],
    { cwd: projectDir },
  );

  // By NAME, not "the first one in the folder". This directory keeps every
  // artefact ever built here, so picking the first match verified whichever
  // version happened to sort earliest — which meant a release could be checked
  // by building yesterday's artefact and calling it green. Reading the declared
  // version and demanding that exact file is what makes this able to fail.
  const version = /<Version>([^<]+)<\/Version>/.exec(
    readFileSync(join(projectDir, 'Tdcv2.Cli.Tool', 'Tdcv2.Cli.Tool.csproj'), 'utf8'),
  )?.[1];
  if (!version) {
    throw new Error('could not read <Version> from Tdcv2.Cli.Tool.csproj');
  }
  const nupkg = `Tdcv2.Cli.${version}.nupkg`;
  if (!existsSync(join(feed, nupkg))) {
    throw new Error(`dotnet pack produced no ${nupkg}`);
  }
  console.log(`installing ${nupkg} into ${toolPath}`);

  // A cached copy of this version would be installed instead of the one just
  // built — that would test the previous tool and pass while this one is broken.
  rmSync(join(homedir(), '.nuget', 'packages', 'tdcv2.cli', version ?? ''), {
    recursive: true,
    force: true,
  });

  // --tool-path rather than -g: a global install would replace whatever the
  // machine already has, and a check should not change the machine it runs on.
  run('dotnet', [
    'tool',
    'install',
    'Tdcv2.Cli',
    '--version',
    version,
    '--tool-path',
    toolPath,
    '--add-source',
    feed,
  ]);

  const configFile = join(work, 'check.tdc');
  writeFileSync(configFile, CONFIG);

  const fromTool = run(join(toolPath, 'tdcv2'), [configFile], { cwd: work }).trimEnd();
  const fromReference = run('node', [
    join(repo, 'typescript', 'dist', 'cli', 'main.js'),
    configFile,
  ]).trimEnd();

  if (fromTool !== fromReference) {
    console.error('the installed tool does not agree with the reference.\n');
    console.error(`tool:\n${fromTool}\nreference:\n${fromReference}`);
    process.exit(1);
  }

  console.log(
    `the installed tool runs outside the repository and matches the reference (${String(fromTool.split('\n').length)} rows)`,
  );
} finally {
  run('node', [join(projectDir, 'scripts', 'bundle-packs.mjs'), 'remove'], { cwd: projectDir });
  rmSync(work, { recursive: true, force: true });
}
