/**
 * Repair cross-page anchors in a translated docs tree.
 *
 * A heading in Spanish produces a Spanish slug, so every link that points at
 * `other-page.mdx#some-english-anchor` goes stale the moment `other-page.mdx` is
 * translated. With one page per translator nobody can see the whole graph, and the
 * breakage only shows up in the build log — so this repairs it mechanically.
 *
 * The rule that makes it possible: a translation keeps the same headings in the
 * same order as its English source. So an anchor is repaired by finding which
 * heading it referred to IN ENGLISH, taking that heading's position, and reading
 * the slug of the heading at the same position in the translation.
 *
 * Usage:  node webdoc/scripts/fix-translated-anchors.mjs <locale> [--write]
 *         (without --write it only reports)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');
const EN = join(SITE, 'docs');

const locale = process.argv[2];
const write = process.argv.includes('--write');
if (!locale) {
  console.error('usage: fix-translated-anchors.mjs <locale> [--write]');
  process.exit(2);
}
const TR = join(SITE, 'i18n', locale, 'docusaurus-plugin-content-docs', 'current');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.mdx')) out.push(p);
  }
  return out;
}

/** Docusaurus uses github-slugger; this is the subset that matters for headings. */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their text
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    .replace(/ /g, '-');
}

/** Headings of a file, in order, skipping fenced code. */
function headings(file) {
  const out = [];
  let fenced = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{2,4})\s+(.*)$/.exec(line);
    if (m) out.push(slug(m[2]));
  }
  return out;
}

const enFiles = walk(EN);
const enHeadings = new Map(); // relative path -> [slug…]
for (const f of enFiles) enHeadings.set(relative(EN, f), headings(f));

const trFiles = walk(TR);
const trHeadings = new Map();
for (const f of trFiles) trHeadings.set(relative(TR, f), headings(f));

let repaired = 0;
let unresolved = 0;

for (const file of trFiles) {
  const rel = relative(TR, file);
  const src = readFileSync(file, 'utf8');
  // [text](path.mdx#anchor) and [text](#anchor)
  const out = src.replace(/\]\(([^)\s#]*\.mdx)?#([^)\s]+)\)/g, (whole, path, anchor) => {
    const targetRel = path
      ? relative(TR, resolve(dirname(file), path))
      : rel;
    const en = enHeadings.get(targetRel);
    const tr = trHeadings.get(targetRel);
    if (!en || !tr) return whole; // target not translated yet — leave it alone
    if (tr.includes(anchor)) return whole; // already correct
    const i = en.indexOf(anchor);
    if (i === -1 || i >= tr.length) {
      unresolved += 1;
      console.log(`  ? ${rel} -> ${targetRel}#${anchor} (no matching English heading)`);
      return whole;
    }
    repaired += 1;
    console.log(`  ✓ ${rel} -> ${targetRel}#${anchor}  =>  #${tr[i]}`);
    return whole.replace(`#${anchor}`, `#${tr[i]}`);
  });
  if (write && out !== src) writeFileSync(file, out);
}

console.log(
  `${locale}: ${repaired} anchors ${write ? 'repaired' : 'to repair'}, ${unresolved} unresolved`,
);
