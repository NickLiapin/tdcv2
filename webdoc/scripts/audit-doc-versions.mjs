/**
 * Fail when the documentation names a version the packages no longer carry.
 *
 * The install pages tell people what to type: a Maven coordinate, a `curl` for a
 * jar with the version in its filename, a table of five registries. Every one of
 * those is a literal number, and none of them moves when the packages do. At
 * 0.1.6 the README still said 0.1.3, the intro and the installation page said
 * 0.1.4, and the jar the installation page told people to download did not exist
 * at the URL it gave.
 *
 * Nothing was broken; nothing was checked either. So this reads the number the
 * packages actually declare and requires the documentation to agree — in all
 * three languages, since a translation drifts exactly as easily.
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
const DECLARED = /"version":\s*"([^"]+)"/.exec(
  readFileSync(join(ROOT, 'typescript', 'package.json'), 'utf8'),
)[1];

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

const stale = [];
for (const file of files) {
  if (HISTORICAL.test(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    if (DSL_VERSION.test(line) || !NAMES_OUR_PACKAGE.test(line)) continue;
    // Not `\b…\b`: that finds "0.0.1" inside 127.0.0.1 and reports every local
    // address in the http pages as a stale version — 63 of them, on the first run.
    // A version is a triple with no further digit or dot on either side.
    for (const m of line.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g)) {
      if (m[0] !== DECLARED) {
        stale.push({ where: `${relative(ROOT, file)}:${String(i + 1)}`, found: m[0], line: line.trim() });
      }
    }
  }
}

if (stale.length > 0) {
  console.log(`The packages declare ${DECLARED}. These say otherwise:\n`);
  for (const s of stale) {
    console.log(`  ${s.where}  →  ${s.found}`);
    console.log(`    ${s.line.slice(0, 110)}`);
  }
  console.log(
    `\n${String(stale.length)} stale mention(s). A reader copies these — a Maven coordinate or a\n` +
      'curl for a jar that is not there costs them the first ten minutes of the project.',
  );
  process.exit(1);
}
console.log(`Every version named in the documentation is ${DECLARED}.`);
