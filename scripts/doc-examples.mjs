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

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "..");

/** The three doc trees, in the order a report should list them. */
export const DOC_ROOTS = [
  join(REPO, "webdoc/docs"),
  join(REPO, "webdoc/i18n/ru/docusaurus-plugin-content-docs/current"),
  join(REPO, "webdoc/i18n/es/docusaurus-plugin-content-docs/current"),
];

/**
 * The clock every doc example runs under, passed as `--now`.
 *
 * Three transcripts on the template page came apart by ONE DAY between the
 * morning that wrote them and the afternoon that checked them: `person.b_day`
 * measures an age window backwards from the wall clock, so the same config and
 * the same seed print a different birthday tomorrow. Refreshing the pages would
 * have hidden it until the next time the calendar moved — a gate that fails on
 * a date nobody chose is a gate people learn to re-run rather than read.
 *
 * All five command lines take `--now`, which is what makes this pinnable at all,
 * and both passes import it from here so the reference and the four ports are
 * never asked about different days.
 */
export const DOC_NOW = "2026-01-01";

/**
 * An example opts out with a comment on the line before it, carrying a reason.
 * Two spellings for one marker: MDX rejects an HTML comment and GitHub markdown
 * renders a JSX one as visible text, so the source carries one and the export the
 * other, and this reads either. The reason is required, so a skip is a decision
 * on record rather than a shrug.
 */
export const SKIP_MARK =
  /(?:<!--|\{\/\*)\s*doc-check:\s*skip\s+(.+?)\s*(?:-->|\*\/\})/;

/**
 * A fenced block right after a config is not always its output — it is often the
 * command that runs it, or a whole terminal session. Those are prose about the
 * example, not a claim about what it prints.
 */
function looksLikeCommand(body) {
  const first = body.split("\n").find((l) => l.trim() !== "") ?? "";
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
  const want = expected.split("\n").map(trimEnd);
  const got = actual.split("\n").map(trimEnd);
  if (want.length === got.length && want.every((line, i) => line === got[i])) {
    return { ok: true, abridged: false };
  }
  if (want.length >= got.length) return { ok: false, abridged: false };
  const ok = want.every((line, i) => line === got[i]);
  return { ok, abridged: ok };
}

function trimEnd(line) {
  return line.replace(/[ \t]+$/, "");
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
  if (body.includes("<tdc") && body.includes("</tdc>")) return body;
  if (body.includes("<env") && body.includes("</block>"))
    return `<tdc>\n${body}\n</tdc>`;
  return undefined;
}

/** The seed a wrapped fragment runs under. Named after the `./run demo.tdc` in every title. */
const FRAGMENT_SEED = "demo";

/**
 * The third shape, and on the generator pages the only one: a bare `<gen …/>`
 * with the column it prints underneath.
 *
 * 109 of the 149 examples on the English generator pages are exactly this, and
 * not one of them was checkable — a `<gen>` alone is not a config, so the engine
 * could never be asked whether the numbers below it were still true. They were
 * kept by hand, which is another way of saying they were kept until somebody
 * forgot.
 *
 * Everything the wrapper needs is either on the page or fixed:
 *
 *   count   the number of lines the page already shows, so `--update` rewrites
 *           the VALUES and never the shape
 *   local   the tree the file lives in — the ru pages print Russian data
 *   seed    `demo`, the one in every `./run demo.tdc` title
 *
 * A `<gen>` that needs more than that carries it itself: `local=` is a generator
 * attribute, and a fragment that cannot run alone (one reading a parent, or a
 * file that is not there) fails and is reported, which is the honest answer
 * rather than a guess at what its author meant.
 */
function wrapFragment(body, expected, locale, title) {
  // The title has to say, exactly, "this is a plain run of a config file".
  // Anything else is the page telling us the block below is NOT the fragment's
  // own output, and three real examples proved how badly a guess reads there:
  //
  //   ./run uniform.tdc (300 rows)            300 heights sorted into BINS
  //   ./run density.tdc --count 6000 | ...    piped through a histogram
  //   tdcv2 check corridor.tdc                a DIAGNOSTIC, not data
  //
  // Completing the fragment under any of those would have replaced a histogram,
  // or an error message, with a column of numbers and called it an update.
  if (!/^\s*\.\/run\s+[\w.-]+\.tdc\s*$/.test(titleOf(title))) return undefined;
  // A comment above the gen is part of the teaching, not part of the config.
  const bare = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!/^<gen\b[\s\S]*?(?:\/>|<\/gen>)$/.test(bare)) return undefined;
  // One generator, not several: `<gen/><gen/>` is a compound, and what a
  // compound prints depends on a layout this cannot know.
  if (bare.slice(1).includes("<gen")) return undefined;
  const count = expected.replace(/\s+$/, "").split("\n").length;
  return (
    `<tdc><env count="${String(count)}" seed="${FRAGMENT_SEED}" local="${locale}">` +
    `<sequence name="V">${bare}</sequence></env>` +
    "<block><line><data>${{V}}</data></line></block></tdc>"
  );
}

/** The `title="…"` of a <Terminal>, or '' when it has none. */
function titleOf(attrs) {
  const m = /\btitle=(?:"([^"]*)"|'([^']*)')/.exec(attrs ?? "");
  return m ? (m[1] ?? m[2] ?? "") : "";
}

/** Which doc tree a file belongs to, which is the locale its examples print in. */
export function localeOf(path) {
  const m = /\/i18n\/([a-z-]+)\//.exec(path);
  return m ? m[1] : "en";
}

/**
 * Pull out (config, claimed output) pairs.
 *
 * The claimed block is whatever fenced block comes next, as long as only prose
 * separates them — a second `xml` block means the first example was showing
 * config, not results.
 */
export function extractExamples(markdown, locale = "en") {
  // `(\w*)` then anything up to the newline: a fence may carry attributes —
  // ```xml title="users.tdc" — and those are the examples a reader copies, so
  // skipping them silently was the worst possible thing for this to do.
  const fence = /^```(\w*)[^\n]*\n([\s\S]*?)^```$/gm;
  const blocks = [];
  let m;
  while ((m = fence.exec(markdown)) !== null) {
    const bodyStart = m.index + m[0].indexOf("\n") + 1;
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
  const terminal = /<Terminal([^>]*)>\s*\{`([\s\S]*?)`\}\s*<\/Terminal>/g;
  while ((m = terminal.exec(markdown)) !== null) {
    const bodyStart = m.index + m[0].indexOf("{`") + 2;
    blocks.push({
      lang: "",
      attrs: m[1],
      body: m[2],
      start: m.index,
      end: terminal.lastIndex,
      bodySpan: [bodyStart, bodyStart + m[2].length],
    });
  }
  blocks.sort((a, b) => a.start - b.start);

  const examples = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.lang !== "xml") continue;

    const next = blocks[i + 1];
    if (!next || next.lang !== "") continue;
    if (looksLikeCommand(next.body)) continue;

    // A whole config runs as written. A bare `<gen>` is completed from what the
    // page already shows — see `wrapFragment`. Anything else stays a reader's
    // job, because finishing it would mean inventing the part that was left out.
    const whole = wholeConfig(block.body);
    const runnable =
      whole ?? wrapFragment(block.body, next.body, locale, next.attrs);
    if (runnable === undefined) continue;

    // Anything other than prose between them means these are not a pair.
    const between = markdown.slice(block.end, next.start);
    if (between.includes("```")) continue;

    const before = markdown.slice(0, block.start);
    const skip = SKIP_MARK.exec(before.slice(-300));

    examples.push({
      line: before.split("\n").length,
      config: runnable,
      // A completed fragment is an inference, so a run that fails means the
      // fragment was not self-contained — not that the page is wrong. A whole
      // config that fails is a real failure and stays one.
      wrapped: whole === undefined,
      expected: next.body.replace(/\s+$/, ""),
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
    for (const [index, example] of extractExamples(
      readFileSync(file, "utf8"),
    ).entries()) {
      out.push({ ...example, file, name, index });
    }
  }
  return out;
}
