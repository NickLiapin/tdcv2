/**
 * Run the examples in the user docs and compare against the output they claim.
 *
 * Documentation rots quietly: an example keeps looking plausible long after the
 * behaviour under it moved, and nothing fails. Auditing by hand found a stale
 * error message and two wrong measurements in one afternoon, which is exactly
 * the kind of thing that should not need an afternoon.
 *
 * This runs the REFERENCE only, which is what keeps it fast enough to sit in
 * `npm run check`. `scripts/audit-doc-examples-five-ways.mjs` runs the same
 * examples through all five implementations — the slower, deeper pass.
 *
 * Which examples count as checkable, and how one opts out, live in
 * `scripts/doc-examples.mjs`, shared so the two passes cannot disagree about
 * what the documentation even claims.
 *
 *   node scripts/check-doc-examples.mjs           # report
 *   node scripts/check-doc-examples.mjs --quiet   # only failures
 *   node scripts/check-doc-examples.mjs --update  # rewrite claims from reality
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOC_ROOTS, docFiles, extractExamples, matches } from '../../scripts/doc-examples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CLI = join(REPO, 'typescript/dist/cli/main.js');

function run(config, dir, index) {
  const file = join(dir, `example-${String(index)}.tdc`);
  writeFileSync(file, config);
  return execFileSync(process.execPath, [CLI, file], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // A doc may legitimately show a config with a large count; we only compare
    // the opening lines, but the child still prints all of it.
    maxBuffer: 512 * 1024 * 1024,
  }).replace(/\s+$/, '');
}

const quiet = process.argv.includes('--quiet');
const dir = mkdtempSync(join(tmpdir(), 'tdc-doc-check-'));
const update = process.argv.includes('--update');
const failures = [];
let updated = 0;
let checked = 0;
let skipped = 0;
let abridged = 0;

for (const file of DOC_ROOTS.flatMap(docFiles)) {
  const name = file.slice(REPO.length + 1);
  let source = readFileSync(file, 'utf8');
  const examples = extractExamples(source);
  // Splices go tail-first so earlier spans stay valid.
  const splices = [];
  for (const [i, ex] of examples.entries()) {
    if (ex.skip !== undefined) {
      skipped++;
      if (!quiet) console.log(`  skip  ${name}:${String(ex.line)} — ${ex.skip}`);
      continue;
    }
    checked++;
    let actual;
    try {
      actual = run(ex.config, dir, i);
    } catch (err) {
      failures.push({
        name,
        line: ex.line,
        expected: ex.expected,
        actual: `RUN FAILED: ${String(err)}`,
      });
      continue;
    }
    const verdict = matches(ex.expected, actual);
    if (!verdict.ok) {
      if (update) {
        // Keep the page's shape: a claim that showed N lines keeps N lines,
        // now the first N the engine actually prints.
        const shown = ex.expected.split('\n').length;
        const trailer = ex.expected.endsWith('\n') ? '\n' : '';
        const replacement = actual.split('\n').slice(0, shown).join('\n') + trailer;
        splices.push([ex.expectedSpan, replacement]);
        updated++;
        continue;
      }
      failures.push({ name, line: ex.line, expected: ex.expected, actual });
    } else {
      if (verdict.abridged) abridged++;
      if (!quiet)
        console.log(`  ok    ${name}:${String(ex.line)}${verdict.abridged ? ' (abridged)' : ''}`);
    }
  }
  if (splices.length > 0) {
    splices.sort((a, b) => b[0][0] - a[0][0]);
    for (const [[from, to], replacement] of splices) {
      source = source.slice(0, from) + replacement + source.slice(to);
    }
    writeFileSync(file, source);
    console.log(`  update ${name} — ${String(splices.length)} example(s) refreshed`);
  }
}

console.log(
  `\n${String(checked)} examples checked (${String(abridged)} abridged), ` +
    `${String(skipped)} skipped, ` +
    (update ? `${String(updated)} refreshed` : `${String(failures.length)} failing`),
);

for (const f of failures) {
  console.log(`\n--- ${f.name}:${String(f.line)}`);
  console.log('  claimed:');
  for (const l of f.expected.split('\n')) console.log(`    ${l}`);
  console.log('  actual:');
  for (const l of f.actual.split('\n')) console.log(`    ${l}`);
}

process.exit(failures.length > 0 ? 1 : 0);
