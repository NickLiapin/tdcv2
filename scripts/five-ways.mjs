#!/usr/bin/env node
/**
 * Run every implementation's own test suite, one after another.
 *
 * The five implementations are held to one contract by `fixtures/cross-language/`,
 * but nothing ran all five together: CI covers TypeScript, and the four ports were
 * only ever checked by hand, one language at a time, by whoever last touched them.
 * A port could sit broken for days without anyone noticing. This is the command
 * that notices.
 *
 * Each language runs its OWN suite rather than some parity-only subset. That is
 * where the shared fixtures live in every one of them, and running the whole suite
 * costs seconds more while catching everything the narrow version would miss.
 *
 * A missing toolchain is a FAILURE, not a quiet skip. "Four of five passed and the
 * fifth never ran" is the exact shape of the bug this command exists to catch, so
 * it has to be loud. Pass `--allow-missing` when you knowingly lack a toolchain.
 *
 *   node scripts/five-ways.mjs
 *   node scripts/five-ways.mjs --only rust,java
 *   node scripts/five-ways.mjs --allow-missing
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How each implementation runs its tests.
 *
 * `command` is the suite. `also` is anything else that must hold for that language
 * and has nowhere else to run — Python's linter is the case: nothing in CI ever
 * invoked ruff, and fourteen violations had accumulated on main by the time an
 * audit thought to look. A gate nobody runs is not a gate.
 *
 * `probe` is the file whose absence means "this toolchain is not installed here" —
 * checked before spawning so a missing tool reads as a missing tool and not as a
 * cryptic ENOENT. Python's is its virtualenv: the suite needs antlr4, and the
 * system interpreter does not have it.
 */
const IMPLEMENTATIONS = [
  {
    id: 'typescript',
    label: 'TypeScript (reference)',
    cwd: 'typescript',
    command: ['npm', ['test', '--silent']],
    install: 'npm ci',
  },
  {
    id: 'python',
    label: 'Python',
    cwd: 'python',
    // Its parser is ANTLR output, generated rather than committed. Nothing else in
    // this package builds, so without this step a fresh checkout fails at import.
    generateParser: true,
    probe: 'python/.venv/bin/python',
    command: ['.venv/bin/python', ['-m', 'pytest', '-q']],
    also: [['.venv/bin/ruff', ['check', 'src', 'tests']]],
    install: 'python3 -m venv python/.venv && python/.venv/bin/pip install -e "python[dev]"',
  },
  {
    id: 'rust',
    label: 'Rust',
    cwd: 'rust',
    command: ['cargo', ['test', '--quiet']],
    install: 'https://rustup.rs',
  },
  {
    id: 'csharp',
    label: 'C#',
    cwd: 'csharp',
    generateParser: true,
    command: ['dotnet', ['test', '--nologo', '-v', 'q']],
    install: 'https://dotnet.microsoft.com/download',
  },
  {
    id: 'java',
    label: 'Java',
    cwd: 'java',
    probe: 'java/gradlew',
    command: ['./gradlew', ['test', '--console=plain', '-q']],
    install: 'a JDK, then ./gradlew wrapper',
  },
];

/** Run one command to completion, keeping its output for the failure report. */
function run(command, args, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => {
      resolve({ code: -1, output: String(error.message), ms: Date.now() - started });
    });
    child.on('close', (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

/** Seconds, one decimal — long enough runs that milliseconds are noise. */
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function main() {
  const argv = process.argv.slice(2);
  const allowMissing = argv.includes('--allow-missing');
  const onlyFlag = argv.indexOf('--only');
  const only =
    onlyFlag < 0 ? null : new Set((argv[onlyFlag + 1] ?? '').split(',').filter(Boolean));

  const selected = IMPLEMENTATIONS.filter((impl) => !only || only.has(impl.id));
  if (selected.length === 0) {
    console.error(`--only matched nothing. Known: ${IMPLEMENTATIONS.map((i) => i.id).join(', ')}`);
    process.exit(2);
  }

  // Java's Gradle plugin and TypeScript's own pretest generate their parsers; Rust's
  // is hand-written. Python and C# have no build of their own, so the step lives here
  // — in the command both a developer and CI run, rather than in one of the two.
  const needParser = selected.filter((impl) => impl.generateParser).map((impl) => impl.id);
  if (needParser.length > 0) {
    const generated = await run(
      process.execPath,
      [join(ROOT, 'scripts', 'generate-parsers.mjs'), '--only', needParser.join(',')],
      ROOT,
    );
    if (generated.code !== 0) {
      console.error(generated.output.trimEnd());
      console.error(`\ncannot generate the parser for: ${needParser.join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`running ${selected.length} implementation${selected.length === 1 ? '' : 's'}\n`);

  const results = [];
  for (const impl of selected) {
    process.stdout.write(`  ${impl.label.padEnd(22)} `);

    if (impl.probe && !existsSync(join(ROOT, impl.probe))) {
      // Not installed — say what is missing and how to get it, then keep going, so
      // one absent toolchain does not hide the state of the other four.
      results.push({ impl, state: 'missing' });
      console.log(`MISSING — ${impl.install}`);
      continue;
    }

    const [command, args] = impl.command;
    let result = await run(command, args, join(ROOT, impl.cwd));
    // The extras run only once the suite is green: a failing test is the more
    // useful thing to read first, and a lint report on top of it is noise.
    for (const [extra, extraArgs] of result.code === 0 ? (impl.also ?? []) : []) {
      const next = await run(extra, extraArgs, join(ROOT, impl.cwd));
      if (next.code !== 0) {
        result = { ...next, ms: result.ms + next.ms };
        break;
      }
      result = { ...result, ms: result.ms + next.ms };
    }
    const state = result.code === 0 ? 'pass' : result.code === -1 ? 'missing' : 'fail';
    results.push({ impl, state, ...result });
    console.log(
      state === 'pass'
        ? `ok ${seconds(result.ms)}`
        : state === 'missing'
          ? `MISSING — ${impl.install}`
          : `FAILED (exit ${result.code}) ${seconds(result.ms)}`,
    );
  }

  // The failure report comes after the table so the table stays readable: one
  // glance says which languages are broken, then the detail for each.
  for (const result of results.filter((r) => r.state === 'fail')) {
    console.log(`\n--- ${result.impl.label} ---`);
    console.log(result.output.trimEnd().split('\n').slice(-40).join('\n'));
  }

  const failed = results.filter((r) => r.state === 'fail');
  const missing = results.filter((r) => r.state === 'missing');
  const passed = results.filter((r) => r.state === 'pass');

  console.log('');
  if (failed.length === 0 && missing.length === 0) {
    console.log(`all ${passed.length} implementations agree with the shared fixtures`);
    return;
  }
  if (failed.length > 0) {
    console.log(`${failed.length} failing: ${failed.map((r) => r.impl.id).join(', ')}`);
  }
  if (missing.length > 0) {
    console.log(
      `${missing.length} never ran: ${missing.map((r) => r.impl.id).join(', ')}` +
        (allowMissing ? ' (allowed)' : ' — install them, or pass --allow-missing'),
    );
  }
  process.exit(failed.length > 0 || (missing.length > 0 && !allowMissing) ? 1 : 0);
}

await main();
