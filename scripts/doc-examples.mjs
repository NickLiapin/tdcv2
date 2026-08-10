/**
 * Find the runnable examples in the user documentation.
 *
 * A self-contained example is a fenced `xml` block holding a whole `<tdc>`
 * document followed by a fenced block showing what it prints. Fragments — the
 * majority — need their surrounding config inferred from the prose, so they stay
 * a job for a reader.
 *
 * Two scripts read the same examples and must agree on which ones exist:
 * `typescript/scripts/check-doc-examples.mjs` runs them on the reference, and
 * `scripts/audit-doc-examples-five-ways.mjs` runs them on all five. Two copies of
 * this extraction would let the two disagree about what the documentation even
 * claims, which is the one thing neither could then detect.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..');

/** The three doc trees, in the order a report should list them. */
export const DOC_ROOTS = [
  join(REPO, 'webdoc/docs'),
  join(REPO, 'webdoc/i18n/ru/docusaurus-plugin-content-docs/current'),
  join(REPO, 'webdoc/i18n/es/docusaurus-plugin-content-docs/current'),
];

/**
 * An example opts out with a comment on the line before it, carrying a reason.
 * Two spellings for one marker: MDX rejects an HTML comment and GitHub markdown
 * renders a JSX one as visible text, so the source carries one and the export the
 * other, and this reads either. The reason is required, so a skip is a decision
 * on record rather than a shrug.
 */
export const SKIP_MARK = /(?:<!--|\{\/\*)\s*doc-check:\s*skip\s+(.+?)\s*(?:-->|\*\/\})/;

/**
 * A fenced block right after a config is not always its output — it is often the
 * command that runs it, or a whole terminal session. Those are prose about the
 * example, not a claim about what it prints.
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
export function matches(expected, actual) {
  // Trailing spaces on a line are compared away, in both directions. A run that
  // prints an empty last column really does emit `US ` with the space, and the
  // page really does say `US` — because prettier strips trailing whitespace from
  // markdown on the way into a commit. Neither is wrong and no reader can tell
  // them apart, so pinning them would make the gate fail every time it passed.
  const want = expected.split('\n').map(trimEnd);
  const got = actual.split('\n').map(trimEnd);
  if (want.length === got.length && want.every((line, i) => line === got[i])) {
    return { ok: true, abridged: false };
  }
  if (want.length >= got.length) return { ok: false, abridged: false };
  const ok = want.every((line, i) => line === got[i]);
  return { ok, abridged: ok };
}

function trimEnd(line) {
  return line.replace(/[ \t]+$/, '');
}

/**
 * The runnable text of an example, or `undefined` when it is only a fragment.
 *
 * Two shapes count. A full `<tdc>…</tdc>` is obvious. The second is the house
 * style of every page that teaches a construct rather than the file format:
 * `<env>…</env>` followed by `<block>…</block>`, with the wrapper left off
 * because it says nothing about the point being made.
 *
 * That second shape was invisible here, and the pages using it are the ones a
 * reader trusts most: hierarchical-dependencies, relational-tables,
 * output-formatting, conditional-output, output-formats. 63 transcripts across
 * the three languages sat outside the gate — the whole reason a hand audit kept
 * finding stale numbers the check had already declared clean.
 */
function wholeConfig(body) {
  if (body.includes('<tdc') && body.includes('</tdc>')) return body;
  if (body.includes('<env') && body.includes('</block>')) return `<tdc>\n${body}\n</tdc>`;
  return undefined;
}

/**
 * Pull out (config, claimed output) pairs.
 *
 * The claimed block is whatever fenced block comes next, as long as only prose
 * separates them — a second `xml` block means the first example was showing
 * config, not results.
 */
export function extractExamples(markdown) {
  // `(\w*)` then anything up to the newline: a fence may carry attributes —
  // ```xml title="users.tdc" — and those are the examples a reader copies, so
  // skipping them silently was the worst possible thing for this to do.
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
  // The site shows program output through the <Terminal> component rather than a
  // bare fence; its template-literal body is the expected text.
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
    if (block.lang !== 'xml') continue;
    const runnable = wholeConfig(block.body);
    if (runnable === undefined) continue; // fragments stay a reader's job

    const next = blocks[i + 1];
    if (!next || next.lang !== '') continue;
    if (looksLikeCommand(next.body)) continue;

    // Anything other than prose between them means these are not a pair.
    const between = markdown.slice(block.end, next.start);
    if (between.includes('```')) continue;

    const before = markdown.slice(0, block.start);
    const skip = SKIP_MARK.exec(before.slice(-300));

    examples.push({
      line: before.split('\n').length,
      config: runnable,
      expected: next.body.replace(/\s+$/, ''),
      expectedSpan: next.bodySpan,
      skip: skip ? skip[1] : undefined,
    });
  }
  return examples;
}

/** Every .md/.mdx under a root, recursively, sorted so reports are stable. */
export function docFiles(root) {
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

/** Every checkable example across the three trees, tagged with where it lives. */
export function allExamples() {
  const out = [];
  for (const file of DOC_ROOTS.flatMap(docFiles)) {
    const name = file.slice(REPO.length + 1);
    for (const [index, example] of extractExamples(readFileSync(file, 'utf8')).entries()) {
      out.push({ ...example, file, name, index });
    }
  }
  return out;
}
