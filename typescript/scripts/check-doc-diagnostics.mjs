/**
 * Every diagnostic the documentation QUOTES still has to be one the engine emits.
 *
 * `check-doc-examples.mjs` runs the examples that pair a complete `<tdc>…</tdc>`
 * with their output. A transcript showing an ERROR almost never has that shape:
 * the config above it is a fragment, or the block is a terminal session. So the
 * error transcripts were the one part of the site nothing checked — and they
 * rotted quietly. `configuration.mdx` printed
 *
 *     error[TDC014]: <env> must not be self-closing — write <env> ... </env>
 *
 * for a message the engine had long since replaced with
 *
 *     error[TDC014]: <env/> cannot be self-closing — its attributes and children
 *                    would be ignored
 *
 * A reader searching for the sentence they saw finds nothing, and the page looks
 * authoritative while being wrong about the one thing a reader arrives with.
 *
 * The comparison is by CODE and by the message's literal SEGMENTS. A message is a
 * template — `unknown child of <env>: "${name}"` — so this turns each template
 * into a pattern, `${…}` becoming "anything", and asks whether the quoted line
 * matches at least one template registered under the same code. That is strict
 * about wording and blind to the value, which is exactly the split that matters:
 * the wording is the page's claim, the value is the example's own.
 *
 *   node scripts/check-doc-diagnostics.mjs           # report
 *   node scripts/check-doc-diagnostics.mjs --quiet   # only failures
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOC_ROOTS, docFiles } from '../../scripts/doc-examples.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CLI = resolve(REPO, 'typescript/dist/cli/main.js');

/** Source files that build diagnostics. Everything under these is scanned. */
const ENGINE_ROOTS = ['typescript/src'];

/**
 * Messages the engine ACTUALLY printed, gathered by running every shared
 * diagnostic case.
 *
 * Reading the source finds most templates and misses the ones assembled a
 * little differently — a message built in a helper, or thrown and caught at the
 * reporting site. Running the cases has no such blind spot: 286 configs go
 * through the real validator and what comes back is what a reader would see.
 * The source templates stay as the fallback for codes no case covers.
 */
function harvestByRunning() {
  const dir = resolve(REPO, 'fixtures/cross-language/diagnostics');
  const configs = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const doc = JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
    for (const c of doc.cases ?? []) configs.push(c.config);
  }
  const byCode = new Map();
  const tmp = mkdtempSync(join(tmpdir(), 'tdc-doc-diag-'));
  configs.forEach((config, i) => {
    const file = join(tmp, `case-${String(i)}.tdc`);
    writeFileSync(file, config);
    let out = '';
    try {
      out = execFileSync(process.execPath, [CLI, 'check', '--brief', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      out = String(err.stdout ?? '') + String(err.stderr ?? '');
    }
    for (const line of out.split('\n')) {
      const m = /^(TDC\d+) \d+:\d+ (.+?)(?: :: |$)/.exec(line.trim());
      if (!m) continue;
      if (!byCode.has(m[1])) byCode.set(m[1], []);
      byCode.get(m[1]).push(m[2]);
    }
  });
  return byCode;
}

/**
 * Message templates, per code, harvested from the reference implementation.
 *
 * Two shapes carry a message: the `{ code, message }` object the validator
 * pushes, and the positional `error('TDCnnn', message, …)` helpers the parser
 * and the pack loader use. Both are matched loosely on purpose — a template that
 * this misses only weakens the check, while a template it invents would fail a
 * page that is right.
 */
function harvestTemplates() {
  const byCode = new Map();
  const loose = [];
  const add = (code, template) => {
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(template);
  };

  for (const file of ENGINE_ROOTS.flatMap((root) => sourceFiles(resolve(REPO, root)))) {
    const src = readFileSync(file, 'utf8');

    // message: `…` / message: '…' followed (within the same object) by code: 'TDCnnn'
    const objectShape = /message:\s*(`[^`]*`|'(?:[^'\\]|\\.)*')[\s\S]{0,600}?code:\s*'(TDC\d+)'/g;
    let m;
    while ((m = objectShape.exec(src)) !== null) add(m[2], m[1].slice(1, -1));

    // The reverse order — code first, then message — used where the object is
    // written the other way round.
    const reversed = /code:\s*'(TDC\d+)'[\s\S]{0,400}?message:\s*(`[^`]*`|'(?:[^'\\]|\\.)*')/g;
    while ((m = reversed.exec(src)) !== null) add(m[1], m[2].slice(1, -1));

    // report(diags, node, 'TDCnnn', `…`) and friends: the code, then the message.
    const positional = /'(TDC\d+)',\s*\n?\s*(`[^`]*`|'(?:[^'\\]|\\.)*')/g;
    while ((m = positional.exec(src)) !== null) add(m[1], m[2].slice(1, -1));

    // Some diagnostics carry a message THROWN from somewhere else and caught at
    // the reporting site — `message: err.message` — so nothing at the `code:`
    // ties the two together. Those templates land in a codeless pool: the
    // wording is still checked, the code is not, which is the honest limit of
    // reading the source rather than running it.
    const thrown = /new (?:Error|RangeError|TypeError)\(\s*(`[^`]*`|'(?:[^'\\]|\\.)*')/g;
    while ((m = thrown.exec(src)) !== null) loose.push(m[1].slice(1, -1));
  }
  return { byCode, loose };
}

/** Every `.ts` under a root, generated parser output excluded (it carries no messages). */
function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'generated') continue;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** A template as a pattern: literal text is exact, `${…}` is anything. */
function toPattern(template, mode = 'whole') {
  const escaped = template
    .split(/\$\{[^}]*\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*?');
  return new RegExp(mode === 'prefix' ? `^${escaped}` : `^${escaped}$`);
}

/**
 * A quoted diagnostic line, cleaned of the page's own punctuation.
 *
 * The docs show these inside `<Terminal>` template literals and inline code, so
 * a line can end with a backtick, a closing brace or a sentence's full stop that
 * belongs to the prose rather than to the message.
 */
function cleanMessage(raw) {
  // A backtick means the transcript ended and the page's own prose began: inside
  // a <Terminal> template literal there are none, and in prose the message is
  // wrapped in inline code. Everything from there on is the page talking.
  const untilProse = raw.split('`')[0];
  return untilProse.replace(/[.,;:]\s*$/, '').trim();
}

/**
 * The quoted line plus its wrapped continuation.
 *
 * A long message does not fit the site's code column, so a transcript breaks it
 * across lines. The continuation is an indented line that is not part of the
 * diagnostic's FRAME — the `-->` locator, the `|` gutter, the `note:`/`help:`
 * lines — and not the blank line that ends the block.
 */
function withContinuation(src, afterIndex, first) {
  const rest = src.slice(afterIndex).split('\n').slice(1);
  let out = first;
  for (const raw of rest) {
    const line = raw.trim();
    // `-->` is the LOCATOR line of a TDC diagnostic, the Rust-style one:
    //
    //     error[TDC050]: <gen type="text"> requires a "value" attribute
    //      --> demo.tdc:1:60
    //       |
    //
    // Not an HTML comment. CodeQL reads the literal as one (js/bad-tag-filter,
    // "only parses --> and not --!>") because the rule cannot know the domain;
    // the finding is dismissed as a false positive rather than the code bent to
    // satisfy it. This script reads our own documentation at build time and
    // parses no markup at all.
    if (line === '' || line === '`}' || /^(-->|\||note:|help:|suggestion:|\$)/.test(line)) break;
    if (!/^\s{2,}/.test(raw)) break;
    if (/^(error|warning)\[TDC/.test(line)) break;
    out += ` ${line.split('`')[0].trim()}`;
  }
  return out.replace(/[.,;:]\s*$/, '').trim();
}

const quiet = process.argv.includes('--quiet');
const { byCode: templates, loose } = harvestTemplates();
const emitted = harvestByRunning();
const failures = [];
let checked = 0;

for (const file of DOC_ROOTS.flatMap(docFiles)) {
  const name = file.slice(REPO.length + 1);
  const src = readFileSync(file, 'utf8');
  const quoted = /(?:error|warning)\[(TDC\d+)\]:\s*([^\n]+)/g;
  let m;
  while ((m = quoted.exec(src)) !== null) {
    const [, code, rawMessage] = m;
    const message = cleanMessage(rawMessage);
    // A line that trails off into prose is the page describing a diagnostic
    // rather than transcribing one; there is nothing to compare.
    if (message.length === 0) continue;
    checked += 1;
    const joined = withContinuation(src, m.index + m[0].length, message);
    const candidates = [message, joined];
    const all = [...(emitted.get(code) ?? []), ...(templates.get(code) ?? []), ...loose];
    // A page may quote a long message down to its first clause and let the rest
    // go; that is an abridged transcript, not a wrong one. A prefix counts, as
    // long as it is long enough to be a claim about the wording.
    if (all.some((t) => candidates.some((c) => toPattern(t).test(c)))) continue;
    if (
      message.length >= 25 &&
      all.some((t) => candidates.some((c) => toPattern(t, 'prefix').test(c)))
    ) {
      continue;
    }
    const known = templates.get(code) ?? [];
    const line = src.slice(0, m.index).split('\n').length;
    failures.push({ name, line, code, message, known: known.length });
  }
}

for (const f of failures) {
  console.log(`\n  ${f.name}:${String(f.line)}`);
  console.log(`    quoted:  ${f.code}: ${f.message}`);
  console.log(
    f.known === 0
      ? `    engine:  no message is registered under ${f.code} — is the code right?`
      : `    engine:  none of the ${String(f.known)} messages under ${f.code} say that`,
  );
}

if (failures.length > 0) {
  console.error(
    `\n${String(failures.length)} of ${String(checked)} quoted diagnostics do not match the engine.\n` +
      "Run the config yourself and paste what it prints — the wording is the page's claim.\n",
  );
  process.exit(1);
}
if (!quiet) console.log(`${String(checked)} quoted diagnostics match the engine`);
