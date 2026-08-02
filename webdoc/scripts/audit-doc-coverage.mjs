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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DOCS = join(HERE, '..', 'docs');
const SRC = join(ROOT, 'typescript', 'src');

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
const srcFiles = walk(SRC, '.ts').filter((f) => !f.includes('generated'));
const srcText = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/** Every name captured by `re` (group 1) across the engine sources. */
function fromEngine(re) {
  return [...new Set([...srcText.matchAll(re)].map((m) => m[1]))].sort();
}

/** A name counts as documented if it appears backticked, as an attribute, or as a tag. */
function mentioned(name) {
  const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\`${q}\`|\\b${q}\\s*=|<${q}[\\s/>]|"${q}"`).test(docText);
}

const groups = [
  { title: 'generator types', names: listOf('KNOWN_GEN_TYPES') },
  { title: 'interpolation filters', names: casesOf('format/transforms.ts', ['applyFilter']) },
  { title: 'compute tags', names: casesOf('compute/evaluate.ts', ['evalElement', 'evalPredicate']) },
  { title: 'diagnostic codes', names: fromEngine(/code:\s*'(TDC\d{3})'/g) },
  { title: 'date format tokens', names: dateTokens() },
  { title: 'distributions', names: casesOf('generators/distribution.ts') },
  { title: 'encodings', names: listOf('ENCODINGS') },
];

/** Members of an exported string-literal array, e.g. `export const X = ['a','b']`. */
function listOf(constName) {
  const decl = new RegExp(`export const ${constName}[^;]*`, 's').exec(srcText)?.[0] ?? '';
  return [...new Set((decl.match(/'([a-zA-Z0-9_]+)'/g) ?? []).map((s) => s.slice(1, -1)))];
}

/**
 * `case 'x':` labels inside one engine file, optionally narrowed to a single
 * exported function.
 *
 * The narrowing is not cosmetic. This script first reported `char` and `lit` as
 * undocumented filters the day transforms.ts grew a second switch — one over the
 * slots of a parsed mask, which has nothing to do with filter names. Scraping a
 * whole file for `case` labels assumes the file has exactly one switch and will
 * keep having one, which is not an assumption a checker gets to make.
 */
function casesOf(relPath, withinFns) {
  const file = join(SRC, relPath);
  const whole = readFileSync(file, 'utf8');
  const sources =
    withinFns === undefined
      ? [whole]
      : withinFns.map((fn) => {
          const start = whole.indexOf(`function ${fn}`);
          if (start === -1) throw new Error(`audit: ${fn} not found in ${relPath}`);
          const end = whole.indexOf('\n}', start); // the line that closes it
          return whole.slice(start, end === -1 ? undefined : end);
        });
  const names = sources.flatMap((text) =>
    (text.match(/case '([a-z_0-9]+)'/g) ?? []).map((s) => s.slice(6, -1)),
  );
  return [...new Set(names)].sort();
}

/** Tokens the date formatter understands, taken from its own token table. */
function dateTokens() {
  const text = readFileSync(join(SRC, 'date', 'format.ts'), 'utf8');
  return [...new Set((text.match(/'([A-Za-z]{1,4})'/g) ?? []).map((s) => s.slice(1, -1)))]
    .filter((t) => /^[A-Za-z]+$/.test(t))
    .sort();
}

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
const engineAttrs = fromEngine(/attr(?:s|Map)\[\s*'([a-z_][a-z_0-9]*)'\s*\]/g);
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
