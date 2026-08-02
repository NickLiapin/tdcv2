/**
 * Every tag, generator type and attribute the engine implements must have a ROW in
 * the reference page that covers it — not merely a mention somewhere in the docs.
 *
 * `audit-doc-coverage.mjs` is the loose check: it asks whether a name appears in
 * the documentation at all, and is deliberately cheap to satisfy so that a whole
 * feature nobody wrote about cannot hide. This is the strict one. It asks the
 * question a reader asks: "I saw `sdlog=` in someone's config — where is the table
 * that tells me what it is?" A name explained only in prose, three pages away from
 * the reference, fails here.
 *
 * It reads the ENGINE for the lists, so a feature added tomorrow shows up here
 * before anyone remembers to document it.
 *
 * Usage:  node webdoc/scripts/audit-reference-rows.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = join(ROOT, 'webdoc', 'docs');
const v = await import(join(ROOT, 'typescript/dist/validator/index.js'));

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.mdx')) out.push(p);
  }
  return out;
}
const pages = Object.fromEntries(walk(DOCS).map((f) => [f.replace(DOCS + '/', ''), readFileSync(f, 'utf8')]));
const all = Object.values(pages).join('\n');

/** A reference TABLE ROW: | `name` | … | — the row that actually explains it. */
const hasRow = (name, file) => {
  const src = file ? (pages[file] ?? '') : all;
  const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A row may name it alone or grouped with siblings, with or without <angle brackets>,
  // and may wrap the name in a link: | `<a>` / `<b>` | … |
  // Anywhere in a table row on that page — a parameter may sit in the second column.
  return new RegExp('^\\|.*`<?' + q + '>?[`/ ]', 'm').test(src);
};
/** A heading dedicated to it. */
const hasHeading = (name) =>
  new RegExp(`^#{2,4} .*\`?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?`, 'm').test(all);

/**
 * Names the engine accepts ONLY so it can refuse them with a pointed message.
 * They belong in the errors reference, not in a table of usable attributes, so a
 * reference row would be actively wrong. Each must still be documented — under
 * the code that refuses it.
 */
const REFUSED = new Map([
  ['attr<case>:default', 'TDC128 — <case> has no conditions'],
  ['attr<case>:if', 'TDC128 — <case> has no conditions'],
]);

const report = [];
function check(kind, name, refFile) {
  const row = hasRow(name, refFile);
  const head = hasHeading(name);
  const mention = new RegExp(`\`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``).test(all);
  const refused = REFUSED.get(`${kind}:${name}`);
  if (refused) {
    // Documented as a refusal. Still checked: the code that refuses it must be
    // in the errors reference, or the reader is told "no" and nothing else.
    const code = refused.split(' ')[0];
    if (!new RegExp('`' + code + '`').test(pages['reference/errors.mdx'] ?? '')) {
      report.push({ kind, name, state: `MISSING (${code} undocumented)` });
    }
    return;
  }
  const state = row ? 'ref-row' : head ? 'heading' : mention ? 'MENTION-ONLY' : 'MISSING';
  report.push({ kind, name, state });
}

for (const t of v.KNOWN_ENV_CHILDREN) check('tag', t, 'reference/tags.mdx');
for (const t of v.KNOWN_TDC_CHILDREN) check('tag', t, 'reference/tags.mdx');
for (const t of ['gen', 'data', 'line', 'block', 'case', 'default', 'map', 'compute']) check('tag', t, 'reference/tags.mdx');
for (const t of v.KNOWN_GEN_TYPES) check('gen-type', t, 'reference/generators.mdx');
for (const [tag, attrs] of v.CLOSED_TAG_ATTRIBUTES) for (const a of attrs) check(`attr<${tag}>`, a, 'reference/attributes.mdx');
for (const a of v.GEN_ATTRIBUTES) check('attr<gen>', a, 'reference/attributes.mdx');
for (const t of v.COMPUTE_TAGS) check('compute', t, 'reference/compute.mdx');

const bad = report.filter((r) => r.state !== 'ref-row');
const seen = new Set();
const uniqBad = bad.filter((r) => (seen.has(r.kind + r.name) ? false : seen.add(r.kind + r.name)));
console.log(`checked ${report.length} names; ${report.length - bad.length} have a reference row\n`);
for (const g of ['MISSING', 'MENTION-ONLY', 'heading']) {
  const rows = uniqBad.filter((r) => r.state === g);
  if (!rows.length) continue;
  console.log(`── ${g} (${rows.length}) ──`);
  for (const r of rows) console.log(`   ${r.kind.padEnd(16)} ${r.name}`);
  console.log();
}
process.exit(uniqBad.length > 0 ? 1 : 0);
