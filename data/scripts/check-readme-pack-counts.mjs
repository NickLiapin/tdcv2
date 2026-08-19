#!/usr/bin/env node
/**
 * A README that states how many packs there are must state the real number.
 *
 * The docs site solves this with placeholders — `%%TDC_PACK_LANGUAGES%%` is
 * substituted from data/bundles.json at build time, so those pages cannot go
 * stale. The per-implementation READMEs are plain markdown with no such
 * pipeline, so they said "ten languages and more than ninety country packs"
 * for months while the catalogue grew to 86 and 152. Nobody was wrong at the
 * time they wrote it; the sentence simply outlived its facts.
 *
 * This is the tie. It reads the numbers actually written in each README and
 * fails when they disagree with the manifest, naming the file and both figures.
 *
 *   node data/scripts/check-readme-pack-counts.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundles = JSON.parse(
  readFileSync(join(ROOT, "data", "bundles.json"), "utf8"),
).bundles;
const countries = bundles.filter((b) => b.country).length;
const languages = bundles.length - countries - 1; // minus `common`

/** Files that state a count, and the phrases that carry it. */
const CLAIMS = [
  ["python/README.md", /(\d+) languages and (\d+)\s*\n?country packs/],
  ["rust/README.md", /(\d+) languages and (\d+) country packs/],
  [
    "rust/README.md",
    /downloaded at runtime — (\d+) languages,\s*\n?(\d+) countries/,
  ],
  [
    "java/README.md",
    /downloaded at runtime — (\d+) languages, (\d+)\s*\n?countries/,
  ],
];

const wrong = [];
for (const [file, pattern] of CLAIMS) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const m = pattern.exec(text);
  if (!m) {
    wrong.push(
      `${file}: the sentence this check watches has been reworded, so the count is no longer ` +
        `tied to anything. Update the pattern in data/scripts/check-readme-pack-counts.mjs.`,
    );
    continue;
  }
  const [, saidLangs, saidCountries] = m;
  if (Number(saidLangs) !== languages || Number(saidCountries) !== countries) {
    wrong.push(
      `${file}: says ${saidLangs} languages and ${saidCountries} countries; ` +
        `data/bundles.json ships ${String(languages)} and ${String(countries)}.`,
    );
  }
}

if (wrong.length > 0) {
  console.error(
    `${String(wrong.length)} README claim(s) disagree with the catalogue:\n`,
  );
  for (const line of wrong) console.error(`  ${line}`);
  console.error(
    "\nThe docs site does this with placeholders and cannot drift; these files are plain\n" +
      "markdown, so the number has to be written and this check has to hold it honest.",
  );
  process.exit(1);
}

console.log(
  `README pack counts match the catalogue (${String(languages)} languages, ${String(countries)} countries)`,
);
