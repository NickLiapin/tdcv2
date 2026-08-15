/**
 * Fail when a documentation SOURCE writes the version out instead of asking for it.
 *
 * The install pages tell people what to type: a Maven coordinate, a `curl` for a
 * jar with the version in its filename, a table of five registries. Every one of
 * those is a literal number, and none of them moves when the packages do. At
 * 0.1.6 the README still said 0.1.3, the intro and the installation page said
 * 0.1.4, and the jar the installation page told people to download did not exist
 * at the URL it gave.
 *
 * The fix was to stop writing it down: the sources carry `%%TDC_VERSION%%` and
 * the build puts the number in — the site through a remark plugin, the markdown
 * export through the same module. So this no longer compares numbers. It refuses
 * a LITERAL version in a source, because a literal is the only way drift can
 * start again.
 *
 * README.md is the exception and is still compared rather than tokenised: GitHub
 * renders it directly from the repository, with no build in between.
 *
 * ── Two kinds of number are deliberately left alone ──────────────────────────
 * `<tdc version="0.1.0">` is the DSL DOCUMENT version, which has its own life
 * and its own reasons to change; rewriting it with the package version would be
 * a silent lie about the language. And the performance page compares 0.1.4
 * against 0.1.5 on purpose — those are measurements, a record of when numbers
 * were taken, not a claim about what to install.
 *
 * Usage:  node webdoc/scripts/audit-doc-versions.mjs
 *         exit 0 = every mention agrees; exit 1 = the list
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** What the packages say, which is the only version that is true. */
const {
  TOKEN,
  VERSION: DECLARED,
  JAVA_TOKEN,
  JAVA_VERSION,
} = await import('../plugins/remark-version.mjs');

/**
 * Where OUR version is named, and nowhere else.
 *
 * Looking for anything version-SHAPED does not work in a project about
 * generating data: the first attempt reported 63 local addresses (127.0.0.1
 * contains 0.0.1), the second reported every sample date (08.11.2023), the
 * semver the identifiers page generates as an example, Node's minimum, and the
 * Spanish thousands separator in 1.000.000.
 *
 * So a line only counts when it also carries a package marker — the coordinate,
 * the install command, the jar filename, the registry URL, the registry's name.
 * Those are exactly the lines a reader copies, and the only ones where a stale
 * number costs anything.
 *
 * The registry NAMES are in the list because the first version of it left them
 * out, and `:::tip[On crates.io — version 0.1.2]` sailed straight through: the
 * check reported everything was current while a page said otherwise. Found by
 * poisoning a page on purpose, which is the only way to learn that a green check
 * is green for the right reason.
 */
const NAMES_OUR_PACKAGE =
  /tdcv2|Tdcv2|nickliapin|npm i |npm install|pip install|cargo add|cargo install|dotnet add|dotnet tool|<version>|repo1\.maven|crates\.io|PyPI|NuGet|Maven Central|npmjs/i;

/** `<tdc version="0.1.0">` is the DSL DOCUMENT version — a different number. */
const DSL_VERSION = /<tdc\s+version=|TDC document version|newer than this runtime/;

/** Pages whose version numbers are a record of the past, not an instruction. */
const HISTORICAL = /guides[/\\]performance\.mdx$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.mdx')) out.push(p);
  }
  return out;
}

const files = [join(ROOT, 'README.md'), ...walk(join(HERE, '..', 'docs')), ...walk(join(HERE, '..', 'i18n'))];

/**
 * A line that tells a reader what to put in a Maven coordinate, or which jar to
 * download.
 *
 * Maven Central caps releases per project per month, so the jar can sit several
 * versions behind the other four registries — `%%TDC_JAVA_VERSION%%` is what the
 * build fills those in with, read from the newest DATED entry in
 * `java/CHANGELOG.md`. Reaching for the general token here is not a cosmetic
 * slip: `<version>` a release ahead of Central does not resolve, and the failure
 * lands in the reader's build rather than ours.
 */
const IS_A_MAVEN_INSTRUCTION = /nickliapin|<version>|cli\.jar|repo1\.maven|Maven Central/;

const stale = [];
for (const file of files) {
  if (HISTORICAL.test(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (IS_A_MAVEN_INSTRUCTION.test(line) && line.includes(TOKEN)) {
      stale.push({
        where: `${relative(ROOT, file)}:${String(i + 1)}`,
        found: TOKEN,
        line: line.trim(),
        why: `Java is its own number — write ${JAVA_TOKEN}`,
      });
    }
    if (DSL_VERSION.test(line) || !NAMES_OUR_PACKAGE.test(line)) continue;
    // Not `\b…\b`: that finds "0.0.1" inside 127.0.0.1 and reports every local
    // address in the http pages as a stale version — 63 of them, on the first run.
    // A version is a triple with no further digit or dot on either side.
    for (const m of line.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g)) {
      // A source page must not name a version at all; README has no build step,
      // so there the number itself is checked.
      const isReadme = file.endsWith('README.md');
      // Two numbers are released, not one: four registries at DECLARED and
      // Maven Central at JAVA_VERSION, which is behind whenever Central's
      // monthly allowance is spent. README has no build step, so both spellings
      // have to be allowed there by value.
      const released = m[0] === DECLARED || m[0] === JAVA_VERSION;
      if (!isReadme || !released) {
        stale.push({
          where: `${relative(ROOT, file)}:${String(i + 1)}`,
          found: m[0],
          line: line.trim(),
          why: isReadme
            ? `neither the released version (${DECLARED}) nor the jar on Central (${JAVA_VERSION})`
            : `write ${TOKEN} instead — the build fills it in`,
        });
      }
    }
  }
}

if (stale.length > 0) {
  console.log(`The packages declare ${DECLARED}. These say otherwise:\n`);
  for (const s of stale) {
    console.log(`  ${s.where}  →  ${s.found}  (${s.why})`);
    console.log(`    ${s.line.slice(0, 110)}`);
  }
  console.log(
    `\n${String(stale.length)} stale mention(s). A reader copies these — a Maven coordinate or a\n` +
      'curl for a jar that is not there costs them the first ten minutes of the project.',
  );
  process.exit(1);
}
console.log(
  `No documentation source writes a version down; the build fills in ${DECLARED}.`,
);
