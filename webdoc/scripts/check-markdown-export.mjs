/**
 * Verify the exported Markdown, and verify it has not drifted from the site.
 *
 * Two jobs, because they fail for different reasons and both are cheap:
 *
 *   --drift   re-export to a temporary directory and diff against the committed
 *             docs/. Red means someone edited the site without re-exporting, or
 *             edited docs/ by hand. This is what keeps the two in step.
 *
 *   default   read the committed docs/ and check it is sound on its own: no JSX
 *             survived outside a code block, every internal link points at a
 *             file that exists, every anchor at a heading that exists, every
 *             image at a file on disk.
 *
 * Run:  node webdoc/scripts/check-markdown-export.mjs [--drift]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE = join(HERE, '..');
const ROOT = join(WEBSITE, '..');
const DOCS = join(ROOT, 'docs');

const problems = [];
const fail = (file, msg) => problems.push(`${relative(ROOT, file)}: ${msg}`);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

/** Blank out fenced code so a check never fires on a code sample. */
function withoutCode(text) {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) =>
    m
      .split('\n')
      .map(() => '')
      .join('\n'),
  );
}

/**
 * GitHub's heading slug: lowercased, punctuation dropped, spaces hyphenated.
 *
 * The underscore survives — GitHub keeps it, and tag names like `<to_number>`
 * are headings here, so stripping it would invent anchors nobody can reach.
 */
function slug(heading) {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

const anchors = new Map();
function anchorsOf(file) {
  if (!anchors.has(file)) {
    const text = withoutCode(readFileSync(file, 'utf8'));
    const set = new Set();
    // Heading anchors, for the links the documentation authors wrote by hand.
    for (const m of text.matchAll(/^#{1,6}\s+(.*)$/gm)) set.add(slug(m[1]));
    // Explicit markers. These are what the generated navigation aims at, and
    // checking them is not circular: the target is literal text in the file,
    // not the output of the same slug function that produced the link.
    for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
    anchors.set(file, set);
  }
  return anchors.get(file);
}

// ------------------------------------------------------------------- drift

if (process.argv.includes('--drift')) {
  const tmp = mkdtempSync(join(tmpdir(), 'tdc-docs-'));
  try {
    execFileSync('node', [join(HERE, 'export-markdown.mjs'), tmp], { stdio: 'pipe' });
    try {
      execFileSync('diff', ['-r', '-q', DOCS, tmp], { stdio: 'pipe' });
    } catch (e) {
      const detail = String(e.stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .slice(0, 20)
        .join('\n');
      console.error(
        'docs/ is out of date with the documentation site.\n\n' +
          `${detail}\n\n` +
          'Run `npm run docs:export` and commit the result. Never edit docs/ by hand —\n' +
          'it is generated from webdoc/docs and webdoc/i18n.',
      );
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('docs/ matches the documentation site');
  process.exit(0);
}

// ------------------------------------------------------------------ soundness

if (!existsSync(DOCS)) {
  console.error('docs/ does not exist — run `npm run docs:export` first');
  process.exit(1);
}

const files = walk(DOCS);
if (files.length === 0) {
  console.error('docs/ holds no markdown');
  process.exit(1);
}

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  const prose = withoutCode(raw);

  // Nothing MDX-shaped may survive where a reader would see it.
  for (const m of prose.matchAll(/<\/?(Terminal|Figure|Legend|Tabs|TabItem)\b/g)) {
    fail(file, `JSX survived the export: <${m[1]}>`);
  }
  for (const m of prose.matchAll(/^:::/gm)) {
    void m;
    fail(file, 'a Docusaurus admonition survived instead of a GitHub alert');
  }
  if (/^import\s+\w+\s+from\s+'@site/m.test(prose)) fail(file, 'an MDX import survived');

  // Every link has to land somewhere real.
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const [path, hash] = href.split('#');
    const target = resolve(dirname(file), path);
    if (!existsSync(target)) {
      fail(file, `link points at nothing: ${href}`);
      continue;
    }
    if (hash && target.endsWith('.md') && !anchorsOf(target).has(hash)) {
      fail(file, `anchor not found in ${relative(DOCS, target).split(sep).join('/')}: #${hash}`);
    }
  }

  // The furniture the reader navigates by. Every page opens with the #top
  // marker; an index carries its heading above the switcher, a content page
  // does not, so the switcher lands on line 3 or line 5.
  const head = raw.split('\n').slice(0, 6);
  if (!head[0]?.includes('name="top"')) fail(file, 'no #top marker on the first line');
  if (!head.some((l) => l.includes('·'))) fail(file, 'no language switcher near the top');
}

if (problems.length > 0) {
  console.error(`${String(problems.length)} problem(s) in the exported markdown:\n`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  if (problems.length > 40) console.error(`  … and ${String(problems.length - 40)} more`);
  process.exit(1);
}

console.log(`checked ${String(files.length)} markdown files: links, anchors and images all resolve`);
