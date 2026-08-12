#!/usr/bin/env node
/**
 * Run every documented example through all five implementations.
 *
 * `typescript/scripts/check-doc-examples.mjs` proves the documentation matches
 * the REFERENCE. That leaves the more interesting question unasked: does a
 * reader who installed the Python package, or the Rust binary, get what the page
 * showed them? The documentation makes one promise for all five, so a port that
 * quietly differs is a broken promise nothing in the repository was checking.
 *
 * The two failures it separates are different bugs with different owners:
 *
 *   DOC   — all five agree with each other and none matches the page. The
 *           engine moved and the page did not. Fix the page.
 *   PORT  — the reference matches the page and a port does not. Fix the port.
 *           This is the one that has to block a release.
 *
 * A run that dies is reported as its own kind of failure rather than as a
 * mismatch, because "the Java build cannot open this config at all" and "Java
 * prints a different surname" want different reading.
 *
 * Every implementation is driven through its command line, built from THIS
 * checkout, so the audit measures the source about to be released and not
 * whatever is installed on the machine.
 *
 *   node scripts/audit-doc-examples-five-ways.mjs
 *   node scripts/audit-doc-examples-five-ways.mjs --only rust,java
 *   node scripts/audit-doc-examples-five-ways.mjs --json report.json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO, allExamples, matches } from './doc-examples.mjs';

/**
 * How each implementation is invoked, and the artefact whose absence means it
 * was never built. A missing build is a hard error: "four of five agreed and the
 * fifth never ran" is precisely the result this audit exists to not produce.
 */
const IMPLEMENTATIONS = [
  {
    id: 'typescript',
    label: 'TypeScript (reference)',
    artefact: 'typescript/dist/cli/main.js',
    sources: 'typescript/src',
    command: [process.execPath, [join(REPO, 'typescript/dist/cli/main.js')]],
    build: 'npm --prefix typescript run build',
  },
  {
    id: 'python',
    label: 'Python',
    artefact: 'python/.venv/bin/tdcv2',
    sources: 'python/src',
    command: [join(REPO, 'python/.venv/bin/tdcv2'), []],
    build: 'python3 -m venv python/.venv && python/.venv/bin/pip install -e "python[dev]"',
  },
  {
    id: 'rust',
    label: 'Rust',
    artefact: 'rust/target/release/tdcv2',
    sources: 'rust/src',
    command: [join(REPO, 'rust/target/release/tdcv2'), []],
    build: 'cargo build --release --manifest-path rust/Cargo.toml',
  },
  {
    id: 'csharp',
    label: 'C#',
    artefact: 'csharp/Tdcv2.Cli.Tool/bin/Release/net6.0/Tdcv2.Cli.dll',
    sources: 'csharp/Tdcv2',
    command: ['dotnet', [join(REPO, 'csharp/Tdcv2.Cli.Tool/bin/Release/net6.0/Tdcv2.Cli.dll')]],
    build: 'dotnet build csharp/Tdcv2.Cli.Tool -c Release',
  },
  {
    id: 'java',
    label: 'Java',
    // The jar carries the version in its name, so naming one pins the audit to a release
    // that will stop existing at the next bump. Found by the file itself instead.
    artefact: javaCliJar(),
    sources: 'java/src/main',
    command: ['java', ['-jar', join(REPO, javaCliJar() ?? '')]],
    build: 'cd java && ./gradlew cliJar',
  },
];

/**
 * The CLI jar for the version this tree declares.
 *
 * It used to be "whatever `-cli.jar` readdir hands back first", which is
 * alphabetical, so a jar left behind by an earlier release WON. That is how this
 * audit came to report six port disagreements on a fixed engine: `build/libs`
 * held 0.1.5, 0.1.6 and 0.1.7 side by side, and Java was judged on a jar built
 * the day before the fix. The report said the ports disagreed. They agreed; the
 * harness was reading the wrong file.
 *
 * So: the version decides, and a missing jar says so by name instead of quietly
 * running an old one.
 */
function javaCliJar() {
  const version = JSON.parse(readFileSync(join(REPO, 'typescript/package.json'), 'utf8')).version;
  return `java/build/libs/tdcv2-${version}-cli.jar`;
}

const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt === -1 ? null : new Set(args[onlyAt + 1].split(','));
const jsonAt = args.indexOf('--json');
const jsonPath = jsonAt === -1 ? null : args[jsonAt + 1];

const chosen = IMPLEMENTATIONS.filter((i) => !only || only.has(i.id));
const missing = chosen.filter((i) => !i.artefact || !existsSync(join(REPO, i.artefact)));
if (missing.length > 0) {
  console.error('These implementations are not built, so the audit would be a lie:\n');
  for (const i of missing) console.error(`  ${i.label}\n    ${i.build}\n`);
  process.exit(2);
}

/** The newest mtime anywhere under a directory. */
function newestUnder(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestUnder(path));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

// A build that EXISTS is not the same as a build that is CURRENT, and the second
// mistake is the more expensive one: a stale binary reports as a disagreement
// between implementations, which reads as a defect in the code rather than in the
// build. That is exactly what happened while preparing 0.2.1 — the Rust release
// binary was a day old, and this audit blamed the engine for a bug that had been
// fixed hours earlier.
const stale = chosen.filter(
  (i) => i.sources && newestUnder(join(REPO, i.sources)) > statSync(join(REPO, i.artefact)).mtimeMs,
);
if (stale.length > 0) {
  console.error('These builds are older than their own sources, so the audit would be a lie:\n');
  for (const i of stale) console.error(`  ${i.label}\n    ${i.build}\n`);
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'tdc-doc-five-'));

/** Run one config, returning its output or the reason it produced none. */
function run(impl, file) {
  const [command, prefix] = impl.command;
  try {
    return {
      output: execFileSync(command, [...prefix, file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 512 * 1024 * 1024,
      }).replace(/\s+$/, ''),
    };
  } catch (err) {
    const detail = (err.stderr || err.stdout || String(err.message)).toString().trim();
    return { crashed: detail.split('\n').slice(0, 4).join('\n') };
  }
}

const examples = allExamples().filter((e) => e.skip === undefined);
console.log(
  `${String(examples.length)} examples × ${String(chosen.length)} implementations\n`,
);

const docDrift = [];
const portDrift = [];
const crashes = [];
let agreed = 0;

for (const [n, ex] of examples.entries()) {
  const file = join(dir, `example-${String(n)}.tdc`);
  writeFileSync(file, ex.config);

  const results = new Map();
  for (const impl of chosen) results.set(impl.id, run(impl, file));

  const where = `${ex.name}:${String(ex.line)}`;

  for (const impl of chosen) {
    const r = results.get(impl.id);
    if (r.crashed !== undefined) crashes.push({ where, impl: impl.label, detail: r.crashed });
  }

  const alive = chosen.filter((i) => results.get(i.id).output !== undefined);
  if (alive.length === 0) continue;

  // The reference is the yardstick when it ran; otherwise the first that did.
  const base = alive.find((i) => i.id === 'typescript') ?? alive[0];
  const baseOutput = results.get(base.id).output;

  const differing = alive.filter((i) => results.get(i.id).output !== baseOutput);
  const claimHeld = matches(ex.expected, baseOutput).ok;

  if (differing.length > 0) {
    portDrift.push({
      where,
      base: base.label,
      others: differing.map((i) => ({
        impl: i.label,
        output: results.get(i.id).output,
      })),
      baseOutput,
      claimHeld,
    });
  } else if (!claimHeld) {
    // Every implementation agrees and none matches the page: the page is stale.
    docDrift.push({ where, expected: ex.expected, actual: baseOutput });
  } else {
    agreed++;
  }

  if ((n + 1) % 20 === 0) console.log(`  … ${String(n + 1)}/${String(examples.length)}`);
}

console.log(`\n${'='.repeat(72)}`);
console.log(`  ${String(agreed)} examples: all implementations agree AND match the page`);
console.log(`  ${String(portDrift.length)} PORT drift — implementations disagree with each other`);
console.log(`  ${String(docDrift.length)} DOC drift  — all agree, page is stale`);
console.log(`  ${String(crashes.length)} runs failed outright`);
console.log('='.repeat(72));

for (const c of crashes) {
  console.log(`\n[CRASH] ${c.where} — ${c.impl}`);
  for (const l of c.detail.split('\n')) console.log(`    ${l}`);
}

for (const d of portDrift) {
  console.log(`\n[PORT] ${d.where}${d.claimHeld ? '' : ' (and the page is stale too)'}`);
  console.log(`  ${d.base} (baseline):`);
  for (const l of d.baseOutput.split('\n').slice(0, 6)) console.log(`    ${l}`);
  for (const o of d.others) {
    console.log(`  ${o.impl}:`);
    for (const l of o.output.split('\n').slice(0, 6)) console.log(`    ${l}`);
  }
}

for (const d of docDrift) {
  console.log(`\n[DOC] ${d.where}`);
  console.log('  page claims:');
  for (const l of d.expected.split('\n').slice(0, 6)) console.log(`    ${l}`);
  console.log('  every implementation prints:');
  for (const l of d.actual.split('\n').slice(0, 6)) console.log(`    ${l}`);
}

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify({ agreed, portDrift, docDrift, crashes }, null, 2)}\n`);
  console.log(`\nwrote ${jsonPath}`);
}

process.exit(portDrift.length + docDrift.length + crashes.length > 0 ? 1 : 0);
