#!/usr/bin/env node
/**
 * Do the four ports still COMPILE?
 *
 * `npm run check` is the command everyone runs, and it only ever knew TypeScript:
 * the root `workspaces` array holds one entry, so Python, Rust, C# and Java were
 * invisible to it. The full cross-language suites live in `npm run parity`
 * (`five-ways.mjs`) and take about a minute and a half — too long to put in front
 * of every commit.
 *
 * This is the cheap half of that: build each port and run none of its tests. It
 * answers one question — "did I just break a port so badly it no longer builds?"
 * — which is the failure that used to survive a green `check`. Anything subtler
 * is what `parity` and the `five-ways` CI workflow are for.
 *
 * A missing toolchain is NOT a failure. Not everyone has a JDK and a .NET SDK on
 * the machine where they edit documentation, and a gate that punishes that would
 * be turned off within a week. Missing reads as `skipped`, and the summary says
 * which, so the answer is never silently narrower than it looks.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `probe` is a file that must exist for the command to be worth trying; without
 * one, the command name itself is looked up on PATH. Both give "skipped" rather
 * than a cryptic ENOENT.
 */
const PORTS = [
  {
    label: 'Python',
    cwd: 'python',
    probe: 'python/.venv/bin/python',
    // Imports the package, which is what a compile is for an interpreted language:
    // a syntax error or a broken import fails here.
    command: ['.venv/bin/python', ['-c', 'import tdcv2']],
    install: 'python3 -m venv python/.venv && python/.venv/bin/pip install -e "python[dev]"',
  },
  {
    label: 'Rust',
    cwd: 'rust',
    command: ['cargo', ['build', '--quiet']],
    install: 'https://rustup.rs',
  },
  {
    label: 'C#',
    cwd: 'csharp',
    command: ['dotnet', ['build', '--nologo', '-v', 'q']],
    install: 'https://dotnet.microsoft.com/download',
  },
  {
    label: 'Java',
    cwd: 'java',
    probe: 'java/gradlew',
    command: ['./gradlew', ['classes', '--console=plain', '-q']],
    install: 'a JDK, then ./gradlew wrapper',
  },
];

function run(command, args, cwd) {
  return new Promise((resolve_) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', (e) => resolve_({ code: -1, output: String(e.message), ms: Date.now() - started }));
    child.on('close', (code) => resolve_({ code, output, ms: Date.now() - started }));
  });
}

/** Is the toolchain here at all? A probe file, or the command on PATH. */
async function available(port) {
  if (port.probe) return existsSync(join(root, port.probe));
  const which = await run('sh', ['-c', `command -v ${port.command[0]}`], root);
  return which.code === 0;
}

const results = [];
for (const port of PORTS) {
  if (!(await available(port))) {
    results.push({ label: port.label, state: 'skipped', install: port.install });
    continue;
  }
  const { code, output, ms } = await run(port.command[0], port.command[1], join(root, port.cwd));
  results.push({ label: port.label, state: code === 0 ? 'ok' : 'failed', ms, output });
}

const failed = results.filter((r) => r.state === 'failed');
for (const r of failed) {
  process.stderr.write(`\n${r.label} does not build:\n${r.output.trimEnd()}\n`);
}

const say = (state) =>
  results
    .filter((r) => r.state === state)
    .map((r) => r.label)
    .join(', ');

const skipped = results.filter((r) => r.state === 'skipped');
const built = results.filter((r) => r.state === 'ok');
const seconds = (built.reduce((t, r) => t + r.ms, 0) / 1000).toFixed(1);

if (failed.length > 0) {
  process.stderr.write(`\nports: ${say('failed')} do not build\n`);
  process.exit(1);
}

process.stdout.write(
  built.length > 0 ? `ports build: ${say('ok')} (${seconds}s)\n` : 'ports build: nothing to build here\n',
);
if (skipped.length > 0) {
  process.stdout.write(`  not checked, no toolchain: ${say('skipped')}\n`);
  for (const r of skipped) process.stdout.write(`    ${r.label} — ${r.install}\n`);
}
