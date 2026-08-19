/**
 * Turn the shipped bundle manifest into the catalogue the docs render.
 *
 * The reader's question is "what packs exist and what is in them", and the only
 * honest answer is the file people actually download. So this reads
 * `data/bundles.json` — the same manifest `index.json` is built from — rather
 * than a list maintained beside it that could disagree.
 *
 * Sizes come from `build/data-packs/index.json` when a build is present. They
 * are an enrichment, not a requirement: the docs must build on a clean clone.
 *
 *   node scripts/build-pack-catalogue.mjs [--check]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "..", "src", "data", "pack-catalogue.json");

const manifest = JSON.parse(
  readFileSync(join(ROOT, "data", "bundles.json"), "utf8"),
).bundles;
const built = join(ROOT, "build", "data-packs", "index.json");
const sizes = existsSync(built)
  ? new Map(
      JSON.parse(readFileSync(built, "utf8")).bundles.map((b) => [
        b.id,
        b.bytes,
      ]),
    )
  : new Map();

/**
 * The description is one sentence ending in the pack's own category list. The
 * list is the useful half for a reader deciding what to install, so it is split
 * out and rendered as chips rather than left as prose that runs off the line.
 */
function split(description) {
  const at = description.indexOf(":");
  if (at === -1) return { blurb: description.trim(), categories: [] };
  const blurb = description.slice(0, at).trim();
  const tail = description.slice(at + 1).replace(/\.$/, "");
  const categories = tail
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !/^and \d+ more$/.test(s));
  const truncated = /and \d+ more/.test(tail);
  return { blurb, categories, truncated };
}

const entry = (b) => ({
  id: b.id,
  name: b.name.replace(/\s*\((language|country)\)$/, ""),
  ...split(b.description),
  bytes: sizes.get(b.id) ?? null,
  regions: b.regions ?? null,
});

const catalogue = {
  generated: "node webdoc/scripts/build-pack-catalogue.mjs",
  common: manifest.filter((b) => !b.locale && !b.country).map(entry),
  languages: manifest
    .filter((b) => b.locale)
    .map(entry)
    .sort((a, b) => a.name.localeCompare(b.name)),
  countries: manifest
    .filter((b) => b.country)
    .map(entry)
    .sort((a, b) => a.name.localeCompare(b.name)),
};

const text = `${JSON.stringify(catalogue, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== text) {
    console.error(
      "webdoc/src/data/pack-catalogue.json is out of date — the docs would describe a\n" +
        "catalogue the project no longer ships.\n" +
        "  run: node webdoc/scripts/build-pack-catalogue.mjs",
    );
    process.exit(1);
  }
  console.log(
    `pack catalogue matches the manifest (${String(catalogue.languages.length)} languages, ` +
      `${String(catalogue.countries.length)} countries)`,
  );
} else {
  writeFileSync(OUT, text);
  console.log(
    `wrote ${String(catalogue.languages.length)} languages and ` +
      `${String(catalogue.countries.length)} countries to src/data/pack-catalogue.json`,
  );
}
