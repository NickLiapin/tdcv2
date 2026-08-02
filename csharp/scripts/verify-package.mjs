#!/usr/bin/env node
/**
 * Install the package the way a stranger receives it, and run one.
 *
 * Every test in this repository runs INSIDE the repository, where `data/packs`
 * is a few directories up and the pack loader finds it by walking. A published
 * package has nothing above it — `~/.nuget/packages/tdcv2/…` — so the whole
 * suite can be green while the artefact a user installs throws
 * `no data packs found` on the first `type="template"`. That is exactly what it
 * did: 775 tests passing, 0 data files in the nupkg.
 *
 * So this packs the project, installs it into a console app OUTSIDE the
 * repository from a local feed, runs a config that touches three different
 * packs, and compares the output against the TypeScript reference.
 *
 *   node scripts/verify-package.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(projectDir, '..');
const feed = join(projectDir, 'Tdcv2', 'bin', 'Release');

/** Three packs, three shapes: a plain list, a check-digited id, a composed one. */
const CONFIG =
  '<tdc><env count="3" seed="package-check" local="en">' +
  '<sequence name="Name"><gen type="template" value="person.lastName"/></sequence>' +
  '<sequence name="Ssn"><gen type="template" value="usa.docs.ssn"/></sequence>' +
  '<sequence name="Iban"><gen type="template" value="common.finance.iban"/></sequence></env>' +
  '<block><line><data>${{Name}} | ${{Ssn}} | ${{Iban}}</data></line></block></tdc>';

const PROGRAM = `using Tdcv2;
var t = new Tdc(new Tdc.Options { ConfigString = ${JSON.stringify(CONFIG)} });
Console.Write(t);
`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts });

// Somewhere with no repository above it.
const work = mkdtempSync(join(tmpdir(), 'tdcv2-nupkg-'));

try {
  console.log('staging the starter packs…');
  run('node', [join(projectDir, 'scripts', 'bundle-packs.mjs'), 'add'], { cwd: projectDir });

  console.log('packing…');
  rmSync(feed, { recursive: true, force: true });
  run('dotnet', ['pack', join(projectDir, 'Tdcv2', 'Tdcv2.csproj'), '-c', 'Release', '-v', 'q', '--nologo'], {
    cwd: projectDir,
  });

  const nupkg = readdirSync(feed).find((f) => f.endsWith('.nupkg'));
  if (!nupkg) {
    throw new Error('dotnet pack produced no .nupkg');
  }
  console.log(`installing ${nupkg} into ${work}`);

  // The version just built must not be served from an earlier cached copy — that
  // would test the previous package and pass while this one is broken.
  const version = /Tdcv2\.(.+)\.nupkg$/.exec(nupkg)?.[1];
  rmSync(join(homedir(), '.nuget', 'packages', 'tdcv2', version ?? ''), {
    recursive: true,
    force: true,
  });

  run('dotnet', ['new', 'console'], { cwd: work });
  writeFileSync(join(work, 'Program.cs'), PROGRAM);
  run('dotnet', ['add', 'package', 'Tdcv2', '--version', version, '--source', feed], { cwd: work });

  const fromPackage = run('dotnet', ['run', '-v', 'q', '--nologo'], { cwd: work })
    .split('\n')
    .filter((l) => l.includes('|'))
    .join('\n');

  const configFile = join(work, 'check.tdc');
  writeFileSync(configFile, CONFIG);
  const fromReference = run('node', [
    join(repo, 'typescript', 'dist', 'cli', 'main.js'),
    configFile,
  ]).trimEnd();

  if (fromPackage !== fromReference) {
    console.error('the installed package does not agree with the reference.\n');
    console.error(`package:\n${fromPackage}\nreference:\n${fromReference}`);
    process.exit(1);
  }

  const rows = fromPackage.split('\n').length;
  console.log(
    `the installed package runs outside the repository and matches the reference (${rows} rows)`,
  );
} finally {
  run('node', [join(projectDir, 'scripts', 'bundle-packs.mjs'), 'remove'], { cwd: projectDir });
  rmSync(work, { recursive: true, force: true });
}
