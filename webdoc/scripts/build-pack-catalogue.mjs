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

import { execFileSync } from "node:child_process";
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

/**
 * Which ids the RELEASED packages can actually address.
 *
 * A pack downloads fine whatever its id, but the address only resolves if the
 * installed package's own registry knows it — so a country registered after the
 * last release is downloadable and unusable, and worse, its presence in the
 * store makes every unrelated config emit TDC171 warnings. Measured on the
 * published 0.2.2: `japan.geo.prefecture` exits 1 with no output, and
 * `usa.geo.state` still works but prints 49 warnings.
 *
 * So the catalogue marks them. The mark is derived from the last release tag,
 * which means it disappears by itself at the next release rather than becoming
 * another sentence somebody has to remember to delete.
 */
function releasedIds() {
  try {
    const tag = execFileSync(
      "git",
      ["describe", "--tags", "--abbrev=0", "--match", "v*"],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    ).trim();
    const src = execFileSync(
      "git",
      ["show", `${tag}:typescript/src/data-pack/locales.ts`],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 1 << 22,
      },
    );
    const set = (name) =>
      new Set(
        [
          ...src
            .match(new RegExp(`${name}[\\s\\S]*?\\]\\)`))[0]
            .matchAll(/'([a-z0-9_-]+)'/g),
        ].map((m) => m[1]),
      );
    return {
      tag,
      ids: new Set([
        ...set("CANONICAL_LOCALES"),
        ...set("CANONICAL_COUNTRIES"),
      ]),
    };
  } catch (error) {
    // No git, no tags, or a shallow clone: say nothing rather than guess. Print it,
    // though — a silent catch here once hid a missing import and marked nothing.
    console.warn(`  (release marks skipped: ${error.message.split("\n")[0]})`);
    return { tag: null, ids: null };
  }
}

const released = releasedIds();

const entry = (b) => ({
  id: b.id,
  name: b.name.replace(/\s*\((language|country)\)$/, ""),
  ...split(b.description),
  bytes: sizes.get(b.id) ?? null,
  regions: b.regions ?? null,
  // true only when we can prove the released registry lacks it
  // `common` is a reserved bucket, not a locale or a country, so it appears in
  // neither registry — asking whether the released version "knows" it always
  // answered no, and the first run marked the one pack that has shipped since
  // the beginning as brand new.
  unreleased:
    released.ids && b.id !== "common" ? !released.ids.has(b.id) : false,
});

const catalogue = {
  releasedTag: released.tag,
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
