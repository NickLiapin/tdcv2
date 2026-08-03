/**
 * Repair cross-page anchors in a translated docs tree.
 *
 * A heading in Spanish produces a Spanish slug, so every link that points at
 * `other-page.mdx#some-english-anchor` goes stale the moment `other-page.mdx` is
 * translated. With one page per translator nobody can see the whole graph, and the
 * breakage only shows up in the build log — so this repairs it mechanically.
 *
 * WHAT THIS SCRIPT MAY NOT DO: guess. It used to map an anchor to a heading by
 * POSITION alone. While a translation was missing a section the English had, every
 * anchor after that point silently resolved to the WRONG heading, and the run still
 * reported "0 unresolved" — that is how English links were once rewritten to
 * `#миллиард-строк`. Position is now the last resort, and it is only trusted when the
 * two files provably line up. Anything else is refused, named, and counted as a
 * failure.
 *
 * How a heading is matched, in order:
 *   1. the anchor already names a heading in the translation → leave it alone;
 *   2. IDENTITY — the English heading and exactly one translated heading carry the
 *      same code tokens (`seed`, `<pool>`, `--data-path`), which survive translation;
 *   3. POSITION — only if the two files have the same number of headings AND the
 *      heading at that position has the same level. Otherwise: refuse.
 *
 * Every rewrite is verified afterwards by re-reading the file and checking that each
 * anchor lands on a heading that exists.
 *
 * Usage:  node webdoc/scripts/fix-translated-anchors.mjs <locale> [--write]
 *         (without --write it only reports)
 *
 * Exit code is 1 when anything was refused or left unresolved.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

// The English tree is a source, never a target. A locale argument that resolves onto
// it means the invocation is wrong, and writing would corrupt the canonical pages.
if (resolve(TR) === resolve(EN) || resolve(EN).startsWith(resolve(TR) + sep)) {
  console.error(`refusing to run: locale "${locale}" resolves onto the English tree`);
  process.exit(2);
}

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

/**
 * The parts of a heading that do NOT get translated: whatever sits in backticks, plus
 * bare flags and tag names. Two headings that agree on these are the same heading in
 * two languages — that is what makes identity matching possible at all.
 */
function tokensOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([^`]+)`/g)) out.add(m[1].trim().toLowerCase());
  for (const m of text.matchAll(/(?:^|\s)(--?[a-z][\w-]*)/g)) out.add(m[1].toLowerCase());
  for (const m of text.matchAll(/<\/?([a-z_][\w-]*)>/gi)) out.add(`<${m[1].toLowerCase()}>`);
  return out;
}

const sameTokens = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));

/** Headings of a file, in order, skipping fenced code. */
function headings(file) {
  const out = [];
  let fenced = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^(#{2,4})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], slug: slug(m[2]), tokens: tokensOf(m[2]) });
  }
  return out;
}

const enFiles = walk(EN);
const enHeadings = new Map(); // relative path -> [heading…]
for (const f of enFiles) enHeadings.set(relative(EN, f), headings(f));

const trFiles = walk(TR);
const trHeadings = new Map();
for (const f of trFiles) trHeadings.set(relative(TR, f), headings(f));

let repaired = 0;
let unresolved = 0;
let refused = 0;

/** Files whose heading counts disagree — reported once, not once per anchor. */
const misaligned = new Map();
for (const [rel, tr] of trHeadings) {
  const en = enHeadings.get(rel);
  if (!en) continue;
  if (en.length !== tr.length) {
    misaligned.set(rel, `English has ${String(en.length)} headings, ${locale} has ${String(tr.length)}`);
  }
}

const ANCHOR = /\]\(([^)\s#]*\.mdx)?#([^)\s]+)\)/g;

for (const file of trFiles) {
  const rel = relative(TR, file);
  const src = readFileSync(file, 'utf8');

  const out = src.replace(ANCHOR, (whole, path, anchor) => {
    const targetAbs = path ? resolve(dirname(file), path) : file;

    // A link that climbs out of the translation tree is never repaired here: the
    // target is somebody else's file, and its anchors are not ours to reinterpret.
    if (targetAbs !== file && !resolve(targetAbs).startsWith(resolve(TR) + sep)) {
      refused += 1;
      console.log(`  ! ${rel} -> ${relative(SITE, targetAbs)}#${anchor} (target is outside ${locale}/)`);
      return whole;
    }

    const targetRel = relative(TR, targetAbs);
    const en = enHeadings.get(targetRel);
    const tr = trHeadings.get(targetRel);
    if (!en || !tr) return whole; // target not translated yet — leave it alone
    if (tr.some((h) => h.slug === anchor)) return whole; // already correct

    const i = en.findIndex((h) => h.slug === anchor);
    if (i === -1) {
      unresolved += 1;
      console.log(`  ? ${rel} -> ${targetRel}#${anchor} (no matching English heading)`);
      return whole;
    }
    const source = en[i];

    // 1. Identity: the code tokens a heading carries survive translation.
    let match = null;
    if (source.tokens.size > 0) {
      const byToken = tr.filter((h) => sameTokens(h.tokens, source.tokens));
      if (byToken.length === 1) match = byToken[0];
      else if (byToken.length > 1) {
        const atPosition = tr[i];
        if (atPosition && byToken.includes(atPosition)) match = atPosition;
      }
    }

    // 2. Position, and only where the two files provably line up.
    if (!match) {
      const why = misaligned.get(targetRel);
      if (why) {
        refused += 1;
        console.log(
          `  ! ${rel} -> ${targetRel}#${anchor}: REFUSED — ${why}. ` +
            `Translate the missing section (or drop the extra one) before repairing anchors.`,
        );
        return whole;
      }
      const candidate = tr[i];
      if (!candidate || candidate.level !== source.level) {
        refused += 1;
        console.log(
          `  ! ${rel} -> ${targetRel}#${anchor}: REFUSED — heading ${String(i + 1)} is ` +
            `h${String(source.level)} in English and ` +
            `${candidate ? `h${String(candidate.level)}` : 'absent'} in ${locale}.`,
        );
        return whole;
      }
      match = candidate;
    }

    repaired += 1;
    console.log(`  ✓ ${rel} -> ${targetRel}#${anchor}  =>  #${match.slug}  ("${match.text}")`);
    return whole.replace(`#${anchor}`, `#${match.slug}`);
  });

  if (write && out !== src) {
    if (!resolve(file).startsWith(resolve(TR) + sep)) {
      console.error(`refusing to write outside ${locale}/: ${file}`);
      process.exit(2);
    }
    writeFileSync(file, out);
  }
}

// ------------------------------------------------------------------ verification
//
// The old failure mode reported success. So the run is not over until every anchor
// that points INTO this tree has been re-read from disk and found on a real heading.

let dangling = 0;
if (write) {
  for (const f of trFiles) trHeadings.set(relative(TR, f), headings(f));
  for (const file of trFiles) {
    const rel = relative(TR, file);
    for (const m of readFileSync(file, 'utf8').matchAll(ANCHOR)) {
      const [, path, anchor] = m;
      const targetAbs = path ? resolve(dirname(file), path) : file;
      const targetRel = relative(TR, targetAbs);
      const tr = trHeadings.get(targetRel);
      if (!tr) continue;
      if (!tr.some((h) => h.slug === anchor)) {
        dangling += 1;
        console.log(`  ✗ ${rel} -> ${targetRel}#${anchor} does not name a heading`);
      }
    }
  }
}

console.log(
  `${locale}: ${String(repaired)} anchors ${write ? 'repaired' : 'to repair'}, ` +
    `${String(refused)} refused, ${String(unresolved)} unresolved` +
    (write ? `, ${String(dangling)} still dangling` : ''),
);

if (misaligned.size > 0) {
  console.log(`\n${String(misaligned.size)} page(s) do not line up with their English source:`);
  for (const [rel, why] of misaligned) console.log(`  ${locale}/${rel}: ${why}`);
  console.log('Anchors into these pages are never remapped by position.');
}

process.exit(refused + unresolved + dangling > 0 ? 1 : 0);
