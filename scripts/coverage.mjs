#!/usr/bin/env node
/**
 * Coverage for all five implementations, measured the same way and shown side by side.
 *
 * TypeScript had a coverage ratchet from the scaffold and the four ports had none, which
 * made the one number anybody quoted a statement about a fifth of the project. That is the
 * wrong shape for a repository whose whole claim is that five implementations behave
 * identically: a branch exercised in TypeScript and never reached in Java is not "Java's
 * problem", it is a place where the two could already differ and nothing would say so.
 *
 * So every implementation reports here, in one table, against a ratchet of its own. The
 * numbers are NOT expected to match each other — the languages structure the same logic
 * differently, and a `match` arm is not a `switch` case — but each one may only go up.
 *
 *   node scripts/coverage.mjs                 every implementation
 *   node scripts/coverage.mjs --only rust     one of them
 *   node scripts/coverage.mjs --update        rewrite the ratchets from what was measured
 *
 * It is deliberately NOT part of `npm run check`: instrumentation takes Python's suite from
 * 40 seconds to six and a half minutes, and a gate that slow in the edit loop is a gate
 * people learn to skip. CI runs it; a developer runs it when they have added tests.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATCHET_FILE = join(ROOT, 'fixtures', 'coverage-ratchet.json');

/**
 * Where `llvm-cov` and `llvm-profdata` actually are, which is not where cargo-llvm-cov looks.
 *
 * Two things go wrong on a real machine and both are silent-ish:
 *
 *  1. cargo-llvm-cov wants a rustup component called `llvm-tools-preview`; rustup installs it
 *     under the name `llvm-tools`, and the tool then reports "failed to find
 *     llvm-tools-preview" and stops.
 *  2. A Homebrew `rustc` and a rustup toolchain can both be present. The compiler on PATH
 *     writes a profile in ITS format while the tools come from the other install, and
 *     llvm-profdata refuses the lot with "raw profile version mismatch: version = 10;
 *     expected version = 9" — measured here with Homebrew rust 1.88 against rustup's 1.79
 *     tools.
 *
 * So the candidates are tried NEWEST-FIRST and the first pair that exists wins: a standalone
 * LLVM is normally ahead of whatever a toolchain ships, and reading a newer profile format
 * with an older tool is the failure above, while the reverse works.
 */
function llvmToolEnv() {
  const candidates = ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin'];
  const sysroot = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' });
  const host = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const target = /host:\s*(\S+)/.exec(host.stdout ?? '')?.[1];
  if (sysroot.status === 0 && target !== undefined) {
    candidates.push(join(sysroot.stdout.trim(), 'lib', 'rustlib', target, 'bin'));
  }
  for (const bin of candidates) {
    const cov = join(bin, 'llvm-cov');
    const profdata = join(bin, 'llvm-profdata');
    if (existsSync(cov) && existsSync(profdata)) return { LLVM_COV: cov, LLVM_PROFDATA: profdata };
  }
  return {};
}

/** Percentage from a covered/total pair, or `undefined` when nothing was measurable. */
function percent(covered, total) {
  if (!Number.isFinite(covered) || !Number.isFinite(total) || total === 0) return undefined;
  return Math.round((covered / total) * 10000) / 100;
}

/** Every `<counter …/>` of a JaCoCo report, summed by type across the whole document. */
function jacocoCounters(xml) {
  const totals = {};
  // The report ends with the document-level counters; taking the LAST of each type is what
  // makes this a whole-project number rather than the last class's.
  for (const m of xml.matchAll(
    /<counter type="(\w+)" missed="(\d+)" covered="(\d+)"\s*\/>/g,
  )) {
    totals[m[1]] = { missed: Number(m[2]), covered: Number(m[3]) };
  }
  return totals;
}

const IMPLEMENTATIONS = [
  {
    id: 'typescript',
    label: 'TypeScript',
    probe: 'typescript/node_modules',
    run: () => ['npm', ['--prefix', 'typescript', 'run', 'test:coverage'], {}],
    read: () => {
      const path = join(ROOT, 'typescript/coverage/coverage-summary.json');
      const total = JSON.parse(readFileSync(path, 'utf8')).total;
      return { lines: total.lines.pct, branches: total.branches.pct };
    },
  },
  {
    id: 'python',
    label: 'Python',
    probe: 'python/.venv/bin/python',
    run: () => [
      '.venv/bin/python',
      ['-m', 'pytest', 'tests', '-q', '--cov', '--cov-report=json:coverage.json'],
      { cwd: join(ROOT, 'python') },
    ],
    read: () => {
      const totals = JSON.parse(readFileSync(join(ROOT, 'python/coverage.json'), 'utf8')).totals;
      return {
        lines: totals.percent_covered,
        branches: percent(totals.covered_branches, totals.num_branches),
      };
    },
  },
  {
    id: 'rust',
    label: 'Rust',
    probe: 'rust/Cargo.toml',
    run: () => [
      'cargo',
      ['llvm-cov', '--manifest-path', 'rust/Cargo.toml', '--json', '--output-path',
       'rust/coverage.json', '--summary-only'],
      { env: { ...process.env, ...llvmToolEnv() } },
    ],
    read: () => {
      const totals = JSON.parse(readFileSync(join(ROOT, 'rust/coverage.json'), 'utf8'))
        .data[0].totals;
      // llvm-cov reports no branches on a stable toolchain — it counts 0 of 0 and would
      // otherwise read as a hard zero, which is a very different claim from "not measured".
      // Regions are the nearest thing it does count, and they are reported in that column.
      return {
        lines: totals.lines.percent,
        branches: totals.branches?.count > 0 ? totals.branches.percent : totals.regions?.percent,
      };
    },
  },
  {
    id: 'java',
    label: 'Java',
    probe: 'java/gradlew',
    run: () => [
      './gradlew',
      ['test', 'jacocoTestReport', '--console=plain', '-q'],
      { cwd: join(ROOT, 'java') },
    ],
    read: () => {
      const xml = readFileSync(
        join(ROOT, 'java/build/reports/jacoco/test/jacocoTestReport.xml'),
        'utf8',
      );
      const c = jacocoCounters(xml);
      return {
        lines: percent(c.LINE?.covered, (c.LINE?.covered ?? 0) + (c.LINE?.missed ?? 0)),
        branches: percent(c.BRANCH?.covered, (c.BRANCH?.covered ?? 0) + (c.BRANCH?.missed ?? 0)),
      };
    },
  },
  {
    id: 'csharp',
    label: 'C#',
    probe: 'csharp/Tdcv2.sln',
    run: () => [
      'dotnet',
      ['test', '--nologo', '-v', 'q', '--collect:XPlat Code Coverage',
       '--results-directory', 'coverage'],
      { cwd: join(ROOT, 'csharp') },
    ],
    read: () => {
      // The collector writes into a directory named for the run, so the newest report wins.
      const dir = join(ROOT, 'csharp/coverage');
      const found = spawnSync('find', [dir, '-name', 'coverage.cobertura.xml'], {
        encoding: 'utf8',
      });
      const files = found.stdout.trim().split('\n').filter(Boolean);
      if (files.length === 0) throw new Error('no cobertura report was written');
      const newest = files
        .map((f) => ({ f, at: statMtime(f) }))
        .sort((a, b) => b.at - a.at)[0].f;
      const xml = readFileSync(newest, 'utf8');
      const rate = (name) => {
        const m = new RegExp(`${name}="([0-9.]+)"`).exec(xml);
        return m ? Math.round(Number(m[1]) * 10000) / 100 : undefined;
      };
      return { lines: rate('line-rate'), branches: rate('branch-rate') };
    },
  },
];

function statMtime(path) {
  const out = spawnSync('stat', ['-f', '%m', path], { encoding: 'utf8' });
  return Number(out.stdout.trim()) || 0;
}

function loadRatchet() {
  if (!existsSync(RATCHET_FILE)) return { comment: '', floors: {} };
  return JSON.parse(readFileSync(RATCHET_FILE, 'utf8'));
}

function main() {
  const argv = process.argv.slice(2);
  const update = argv.includes('--update');
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? (argv[onlyAt + 1] ?? '').split(',').filter(Boolean) : [];

  const ratchet = loadRatchet();
  const chosen = IMPLEMENTATIONS.filter((i) => only.length === 0 || only.includes(i.id));
  const measured = {};
  let failed = 0;

  for (const impl of chosen) {
    if (!existsSync(join(ROOT, impl.probe))) {
      console.error(`  ${impl.label.padEnd(11)} toolchain not installed (${impl.probe})`);
      failed += 1;
      continue;
    }
    process.stdout.write(`  ${impl.label.padEnd(11)} measuring…\r`);
    const [command, args, options] = impl.run();
    const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
    if (result.status !== 0) {
      console.error(`  ${impl.label.padEnd(11)} the suite failed; coverage not measured`);
      failed += 1;
      continue;
    }
    measured[impl.id] = impl.read();
  }

  console.log('\n  implementation   lines   branches   floor (lines / branches)');
  for (const impl of chosen) {
    const m = measured[impl.id];
    if (!m) continue;
    const floor = ratchet.floors[impl.id] ?? { lines: 0, branches: 0 };
    const show = (n) => (n === undefined ? '   —  ' : `${n.toFixed(2)}%`.padStart(7));
    const slipped =
      (m.lines !== undefined && m.lines < floor.lines) ||
      (m.branches !== undefined && m.branches < floor.branches);
    console.log(
      `  ${impl.label.padEnd(14)} ${show(m.lines)} ${show(m.branches)}    ` +
        `${String(floor.lines)} / ${String(floor.branches)}` +
        (slipped ? '   SLIPPED' : ''),
    );
    if (slipped) failed += 1;
  }

  if (update) {
    // Kept to a TENTH of a percent, not a whole one. A round of negative tests moved Java's
    // branches from 71.23 to 71.93 and a whole-number floor would have recorded no change at
    // all — a ratchet that cannot hear a gain is not holding anything.
    const down = (n) => Math.floor((n ?? 0) * 10) / 10;
    const floors = { ...ratchet.floors };
    for (const [id, m] of Object.entries(measured)) {
      floors[id] = { lines: down(m.lines), branches: down(m.branches) };
    }
    writeFileSync(RATCHET_FILE, `${JSON.stringify({ ...ratchet, floors }, null, 2)}\n`);
    console.log('\n  ratchet updated');
    // Said every time, because it has already cost a red main and three red Dependabot PRs:
    // the GATE is the CI runner, and it does not always measure what this machine measures.
    // On 2026-09-08 C# came out 0.45pp lower there on the same commit, which was enough to
    // fail a floor raised here. Numbers from a laptop are a proposal until CI agrees.
    console.log('  confirm these against a CI run before committing them — the runner is the');
    console.log('  gate, and it has measured up to half a point less than a developer machine');
    return 0;
  }

  console.log(
    failed === 0
      ? '\n  every implementation is at or above its floor'
      : `\n  ${String(failed)} implementation(s) below the floor or unmeasured`,
  );
  return failed === 0 ? 0 : 1;
}

process.exit(main());
