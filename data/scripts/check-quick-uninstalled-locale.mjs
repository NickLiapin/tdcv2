#!/usr/bin/env node
/**
 * The "uninstalled pack" vector must name a locale that is still uninstalled.
 *
 * `fixtures/cross-language/quick-vectors.json` proves that asking for a pack
 * nobody has installed says so, instead of proposing a near-miss in another
 * language. To prove it, the vector has to name a locale code that is REAL —
 * so the address parses — and holds no data, so the draw fails.
 *
 * It named `af`. Then Afrikaans was written, `af` resolved, and the vector
 * stopped testing anything: the draw succeeded and five implementations' tests
 * went red at once, hours after the pack that broke them landed. Nothing tied
 * the vector to the packs, so nothing said the premise had died.
 *
 * This is that tie. It fails the moment somebody writes data for whichever
 * locale the vector currently names, and says what to do about it.
 *
 *   node data/scripts/check-quick-uninstalled-locale.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VECTORS = join(ROOT, "fixtures", "cross-language", "quick-vectors.json");
const PACKS = join(ROOT, "data", "packs");
const VECTOR_NAME = "an-uninstalled-pack-is-not-a-typo";

const vectors = JSON.parse(readFileSync(VECTORS, "utf8"));
/* The vectors are grouped by kind; this one lives under `diagnostics`. Search
   every array so a regrouping does not quietly turn the tie into a no-op. */
const list = Object.values(vectors).filter(Array.isArray).flat();
const vector = list.find((v) => v.name === VECTOR_NAME);

if (!vector) {
  console.error(
    `no vector named "${VECTOR_NAME}" in ${VECTORS}.\n` +
      "It was renamed or removed — update this check to match, or the tie is lost again.",
  );
  process.exit(1);
}

const locale = String(vector.address).split(".")[0];
const dir = join(PACKS, locale);

/** Count real data, not the _locale.json that every placeholder carries. */
function txtFiles(d) {
  if (!existsSync(d) || !statSync(d).isDirectory()) return 0;
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n += txtFiles(join(d, e.name));
    else if (e.name.endsWith(".txt")) n++;
  }
  return n;
}

const files = txtFiles(dir);
if (files > 0) {
  console.error(
    `the "${VECTOR_NAME}" vector draws from "${locale}", and data/packs/${locale} now holds\n` +
      `${String(files)} data file(s). The draw will SUCCEED, so the vector proves nothing and the\n` +
      "quick tests fail in all five implementations.\n\n" +
      "Point the vector at a locale that will never hold data — a canonical code with no\n" +
      "language behind it — and update fixtures/cross-language/quick-vectors.json together\n" +
      "with typescript/test/quick/quick.test.ts's hardcoded strings.",
  );
  process.exit(1);
}

/*
 * The vector is shared, but each implementation ALSO hardcodes the locale in its
 * own quick test — which is how one written pack turned five suites red at once
 * while the shared fixture itself looked fine. Check all five against it.
 */
const SUITES = [
  "typescript/test/quick/quick.test.ts",
  "python/tests/test_quick.py",
  "rust/tests/quick.rs",
  "java/src/test/java/io/github/nickliapin/tdc/QuickTest.java",
  "csharp/Tdcv2.Tests/QuickTest.cs",
];

const drifted = [];
for (const suite of SUITES) {
  const path = join(ROOT, suite);
  if (!existsSync(path)) {
    drifted.push(`${suite}: missing — this check can no longer see it`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  if (!text.includes(`${locale}.person.lastName`)) {
    drifted.push(
      `${suite}: does not draw "${locale}.person.lastName" like the shared vector does`,
    );
    continue;
  }
  /*
   * Drawing the right address is not enough — the ASSERTION has to name the same
   * locale. Three suites write the quoted name with escaped quotes, so a
   * search-and-replace over the plain form updated the draw and left the
   * expectation behind: the engine answered "x-pseudo" while the test still
   * demanded "af", and it failed for the opposite of the original reason.
   */
  for (const m of text.matchAll(
    /\\?"([a-z0-9-]+)\\?" pack is not installed/g,
  )) {
    if (m[1] !== locale) {
      drifted.push(
        `${suite}: asserts the message names "${m[1]}", but the draw and the vector use "${locale}"`,
      );
    }
  }
}

if (drifted.length > 0) {
  console.error(
    `${String(drifted.length)} quick suite(s) disagree with the shared vector:\n`,
  );
  for (const line of drifted) console.error(`  ${line}`);
  console.error(
    `\nAll five must draw the same uninstalled locale ("${locale}"), or one implementation\n` +
      "proves something the others do not.",
  );
  process.exit(1);
}

console.log(
  `the uninstalled-pack vector still names an empty locale ("${locale}"), and all ` +
    `${String(SUITES.length)} suites agree`,
);
