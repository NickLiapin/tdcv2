/**
 * Compare the STRUCTURE of every page against its two translations.
 *
 * Words differ between the three trees; shape must not. A section that exists in
 * Russian and not in English is not a translation choice, it is a page someone
 * edited without carrying the edit across — which is exactly how the "processor,
 * not a generator" warning survived in two languages and vanished from the
 * third, unnoticed, for a week.
 *
 * What is compared, per page:
 *   - the sequence of heading levels (## / ###) — text is translated, depth is not
 *   - the admonition types, in order (:::caution, :::tip, …)
 *   - how many <Figure>, <Legend>, <Terminal>, <Tabs> the page uses
 *   - the sequence of fenced-code languages
 *   - which images it points at
 *
 * A missing translation file is reported too: the site quietly falls back to
 * English, so nobody notices until a reader does.
 *
 *   node scripts/check-translation-parity.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const EN = join(SITE, 'docs');
const TRANSLATIONS = ['ru', 'es'].map((code) => ({
  code,
  root: join(SITE, 'i18n', code, 'docusaurus-plugin-content-docs', 'current'),
}));

function pages(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.mdx') || name.endsWith('.md')) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

/** Fenced code is skipped everywhere: a sample may legitimately contain `:::`. */
function withoutFences(text) {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, '');
}

function shapeOf(text) {
  const body = withoutFences(text);
  const count = (re) => (text.match(re) ?? []).length;
  return {
    headings: [...body.matchAll(/^(#{2,4})\s/gm)].map((m) => m[1]).join(' '),
    admonitions: [...body.matchAll(/^:::(\w+)/gm)].map((m) => m[1]).join(' '),
    fences: [...text.matchAll(/^```(\w*)/gm)]
      .filter((_, i) => i % 2 === 0)
      .map((m) => m[1] || 'text')
      .join(' '),
    figures: count(/<Figure\b/g),
    legends: count(/<Legend\b/g),
    terminals: count(/<Terminal\b/g),
    tabs: count(/<TabItem\b/g),
    images: [...text.matchAll(/src="(\/img\/[^"]+)"/g)]
      .map((m) => m[1])
      .sort()
      .join(' '),
  };
}

const LABEL = {
  headings: 'heading levels',
  admonitions: 'admonitions',
  fences: 'code blocks',
  figures: 'figures',
  legends: 'legends',
  terminals: 'terminal blocks',
  tabs: 'tabs',
  images: 'images',
};

/** Show where two sequences part company, not the whole of both. */
function firstDifference(a, b) {
  const left = String(a).split(' ');
  const right = String(b).split(' ');
  const i = left.findIndex((v, k) => v !== right[k]);
  if (i === -1) return `${String(left.length)} vs ${String(right.length)}`;
  return `item ${String(i + 1)}: "${left[i] ?? '(none)'}" vs "${right[i] ?? '(none)'}"`;
}

let problems = 0;
for (const file of pages(EN)) {
  const rel = relative(EN, file);
  const en = shapeOf(readFileSync(file, 'utf8'));
  for (const { code, root } of TRANSLATIONS) {
    const twin = join(root, rel);
    let text;
    try {
      text = readFileSync(twin, 'utf8');
    } catch {
      console.log(`  MISSING  ${code}/${rel}`);
      problems++;
      continue;
    }
    const other = shapeOf(text);
    for (const key of Object.keys(en)) {
      if (String(en[key]) === String(other[key])) continue;
      console.log(`  ${rel} — ${code} differs in ${LABEL[key]}: ${firstDifference(en[key], other[key])}`);
      problems++;
    }
  }
}

console.log(
  problems === 0
    ? 'the three documentation trees have the same shape'
    : `\n${String(problems)} structural difference(s) between the translations`,
);
process.exit(problems > 0 ? 1 : 0);
