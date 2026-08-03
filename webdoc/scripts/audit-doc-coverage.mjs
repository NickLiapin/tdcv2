/**
 * Fail when the engine gains a feature the English documentation never mentions.
 *
 * The check reads the ENGINE for its surface — generator types, filters, compute
 * tags, attributes, diagnostic codes, date tokens, distributions, encodings — and
 * then looks for each name in webdoc/docs. English is the canonical tree; the
 * translations are checked by the site build, not here.
 *
 * ── Why the search is deliberately loose ──────────────────────────────────────
 * The audit that produced this script first looked for `name=` and reported three
 * features as undocumented that were in fact documented — in a table and in prose,
 * with no XML example anywhere on the page. A false alarm is worse than a missed
 * one here: it sends someone to rewrite a page that was already correct, and after
 * two or three of those nobody trusts the check. So a feature counts as documented
 * if its name appears in the docs AT ALL in a plausible form — backticked, as an
 * attribute, as a tag. Cheap to satisfy on purpose: the point is to catch a whole
 * feature nobody wrote about, not to grade how well it was written.
 *
 * Usage:  node webdoc/scripts/audit-doc-coverage.mjs
 *         exit 0 = every name is mentioned; exit 1 = the list of what is not
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { engineAttributes, groups as engineGroups } from '../../scripts/engine-surface.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, '..', 'docs');

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const docText = walk(DOCS, '.mdx')
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** A name counts as documented if it appears backticked, as an attribute, or as a tag. */
function mentioned(name) {
  const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\`${q}\`|\\b${q}\\s*=|<${q}[\\s/>]|"${q}"`).test(docText);
}

const groups = engineGroups();

let failed = 0;
for (const { title, names } of groups) {
  const missing = names.filter((n) => !mentioned(n));
  const mark = missing.length === 0 ? '✓' : '✗';
  console.log(`${mark} ${title}: ${names.length - missing.length}/${names.length}`);
  if (missing.length > 0) {
    failed += missing.length;
    console.log(`    undocumented: ${missing.join(', ')}`);
  }
}

// The attributes reference promises completeness, so hold it to that separately:
// every attribute the engine reads by name must appear on that one page.
const attrsPage = readFileSync(join(DOCS, 'reference', 'attributes.mdx'), 'utf8');
const listedOnPage = new Set([...attrsPage.matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]));
const engineAttrs = engineAttributes();
// Attributes belonging to a single <compute> tag are covered by the compute pages;
// the attributes page says so rather than repeating twenty of them.
const COMPUTE_OWNED = new Set(['as', 'default', 'fill', 'pattern', 'sep', 'size', 'width', 'v']);
const missingAttrs = engineAttrs.filter((a) => !COMPUTE_OWNED.has(a) && !listedOnPage.has(a));
console.log(
  `${missingAttrs.length === 0 ? '✓' : '✗'} attributes reference: ` +
    `${engineAttrs.length - missingAttrs.length}/${engineAttrs.length}`,
);
if (missingAttrs.length > 0) {
  failed += missingAttrs.length;
  console.log(`    missing from reference/attributes.mdx: ${missingAttrs.join(', ')}`);
}

if (failed > 0) {
  console.log(
    `\n${failed} name(s) the engine implements are absent from the English docs.\n` +
      'Document them, or — if the name is internal and never reaches a config — ' +
      'narrow the extraction in this script so it stops claiming otherwise.',
  );
  process.exit(1);
}
console.log('\nEvery name the engine implements is mentioned in the English docs.');
