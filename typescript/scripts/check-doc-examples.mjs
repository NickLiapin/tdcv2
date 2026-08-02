/**
 * Run the examples in the user docs and compare against the output they claim.
 *
 * Documentation rots quietly: an example keeps looking plausible long after the
 * behaviour under it moved, and nothing fails. Auditing by hand found a stale
 * error message and two wrong measurements in one afternoon, which is exactly
 * the kind of thing that should not need an afternoon.
 *
 * Only SELF-CONTAINED examples are checked — a fenced `xml` block holding a
 * whole `<tdc>` document, followed by a fenced block showing what it prints.
 * Fragments (the majority) need their surrounding config inferred from the
 * prose, so they stay a job for a reader.
 *
 * An example opts out with a comment on the line before it, carrying a reason.
 * The MDX source spells it as a JSX comment and the exported markdown as an HTML
 * one; both are read here. (Not shown literally — a JSX comment cannot be quoted
 * inside a block comment without ending it.)
 * Use it for output that is deliberately abridged ("first 6 of 1000") or that
 * depends on the machine. The reason is required so a skip is a decision on
 * record rather than a shrug.
 *
 *   node scripts/check-doc-examples.mjs           # report
 *   node scripts/check-doc-examples.mjs --quiet   # only failures
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
// The three doc trees. `docs/user/ru` — the original home — was folded into
// the Docusaurus site; scanning the old path made this script a silent no-op.
const DOC_ROOTS = [
  join(REPO, 'webdoc/docs'),
  join(REPO, 'webdoc/i18n/ru/docusaurus-plugin-content-docs/current'),
  join(REPO, 'webdoc/i18n/es/docusaurus-plugin-content-docs/current'),
];
const CLI = join(REPO, 'typescript/dist/cli/main.js');

// Two spellings for one marker: MDX rejects an HTML comment, and GitHub markdown
// renders a JSX one as visible text — so the source carries `{/* … */}` and the
// export carries `<!-- … -->`, and this reads either.
const SKIP_MARK = /(?:<!--|\{\/\*)\s*doc-check:\s*skip\s+(.+?)\s*(?:-->|\*\/\})/;

/**
 * A fenced block right after a config is not always its output — it is often
 * the command that runs it, or a whole terminal session. Those are prose about
 * the example, not a claim about what it prints.
 */
function looksLikeCommand(body) {
  const first = body.split('\n').find((l) => l.trim() !== '') ?? '';
  return /^\s*(\$|#|tdcv2\b|npx\b|node\b|pnpm\b|yarn\b)/.test(first);
}

/**
 * Docs routinely show the first few rows of a long run ("первые 6 из 1000").
 * Truncation is fine; a CHANGED VALUE is not. So a claim that is an exact
 * line-prefix of the real output counts as kept — every line the doc does show
 * still has to match character for character.
 */
function matches(expected, actual) {
  if (expected === actual) return { ok: true, abridged: false };
  const want = expected.split('\n');
  const got = actual.split('\n');
  if (want.length >= got.length) return { ok: false, abridged: false };
  const ok = want.every((line, i) => line === got[i]);
  return { ok, abridged: ok };
}

/**
 * Pull out (config, claimed output) pairs.
 *
 * The claimed block is whatever fenced block comes next, as long as only prose
 * separates them — a second `xml` block means the first example was showing
 * config, not results.
 */
function extractExamples(markdown) {
  // `(\w*)` then anything up to the newline: a fence may carry attributes —
  // ```xml title="users.tdc" — and those are the examples a reader copies, so
  // skipping them silently was the worst possible thing for this check to do.
  const fence = /^```(\w*)[^\n]*\n([\s\S]*?)^```$/gm;
  const blocks = [];
  let m;
  while ((m = fence.exec(markdown)) !== null) {
    const bodyStart = m.index + m[0].indexOf('\n') + 1;
    blocks.push({
      lang: m[1],
      body: m[2],
      start: m.index,
      end: fence.lastIndex,
      bodySpan: [bodyStart, bodyStart + m[2].length],
    });
  }
  // The site shows program output through the <Terminal> component rather than
  // a bare fence; its template-literal body is the expected text.
  const terminal = /<Terminal[^>]*>\s*\{`([\s\S]*?)`\}\s*<\/Terminal>/g;
  while ((m = terminal.exec(markdown)) !== null) {
    const bodyStart = m.index + m[0].indexOf('{`') + 2;
    blocks.push({
      lang: '',
      body: m[1],
      start: m.index,
      end: terminal.lastIndex,
      bodySpan: [bodyStart, bodyStart + m[1].length],
    });
  }
  blocks.sort((a, b) => a.start - b.start);

  const examples = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.lang !== 'xml' || !block.body.includes('<tdc')) continue;
    if (!block.body.includes('</tdc>')) continue; // fragments stay a reader's job

    const next = blocks[i + 1];
    if (!next || next.lang !== '') continue;
    if (looksLikeCommand(next.body)) continue;

    // Anything other than prose between them means these are not a pair.
    const between = markdown.slice(block.end, next.start);
    if (between.includes('```')) continue;

    const before = markdown.slice(0, block.start);
    const skip = SKIP_MARK.exec(before.slice(-300));
    const lineNo = before.split('\n').length;

    examples.push({
      line: lineNo,
      config: block.body,
      expected: next.body.replace(/\s+$/, ''),
      expectedSpan: next.bodySpan,
      skip: skip ? skip[1] : undefined,
    });
  }
  return examples;
}

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

/** Every .md/.mdx under a root, recursively, repo-relative for the report. */
function docFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(md|mdx)$/.test(entry.name)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

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
