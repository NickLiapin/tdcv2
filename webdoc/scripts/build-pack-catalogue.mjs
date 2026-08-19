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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * Everything a pack actually holds, read off disk and grouped by its first
 * segment.
 *
 * NOT from the manifest's description. That sentence caps its list at twelve
 * and ends "and more", which is the opposite of what this page is for — a
 * reader is here to find out whether the thing they need is inside, and a
 * truncated list cannot answer that. Worse, `common`'s description is
 * hand-written prose, so splitting it on commas produced chips like
 * "card PANs" that are not addresses at all and cannot be looked up.
 *
 * Reading the tree gives the real names, all of them: 29,985 across the
 * catalogue, about 0.6 MB, which is a fair price for a page whose entire job
 * is to say what is in there.
 */
function contentsOf(dir) {
  const groups = new Map();
  let count = 0;
  const walk = (at, prefix) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const next = prefix ? `${prefix}.${e.name}` : e.name;
      if (e.isDirectory()) walk(join(at, e.name), next);
      else if (e.name.endsWith(".txt")) {
        const address = next.replace(/\.txt$/, "");
        const head = address.split(".")[0];
        const rest = address.slice(head.length + 1) || head;
        if (!groups.has(head)) groups.set(head, []);
        groups.get(head).push(rest);
        count += 1;
      }
    }
  };
  walk(dir, "");
  return {
    count,
    groups: [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, leaves]) => [
        name,
        leaves.sort((x, y) => x.localeCompare(y)),
      ]),
  };
}

/** The blurb is the half of the description BEFORE the colon — the sentence. */
function blurbOf(description) {
  const at = description.indexOf(":");
  return (at === -1 ? description : description.slice(0, at)).trim();
}

/**
 * Which ids the RELEASED packages can actually address.
 *
 * A pack downloads fine whatever its id, but on a released version the address
 * only resolves if that build's own registry knows it — so a country added
 * after the last release is downloadable and unusable there, and its presence
 * in the store makes unrelated configs warn. Measured on the published 0.2.2.
 *
 * Derived from the last release tag, so the mark clears itself at the next
 * release instead of becoming a sentence somebody must remember to delete.
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
    // No git, no tags, or a shallow clone: say nothing rather than guess. Print
    // it, though — a silent catch here once hid a missing import and marked
    // nothing at all.
    console.warn(`  (release marks skipped: ${error.message.split("\n")[0]})`);
    return { tag: null, ids: null };
  }
}

const released = releasedIds();

const entry = (b) => {
  const contents = contentsOf(join(ROOT, "data", b.packs[0]));
  return {
    id: b.id,
    name: b.name.replace(/\s*\((language|country)\)$/, ""),
    blurb: blurbOf(b.description),
    files: contents.count,
    groups: contents.groups,
    bytes: sizes.get(b.id) ?? null,
    regions: b.regions ?? null,
    unreleased:
      released.ids && b.id !== "common" ? !released.ids.has(b.id) : false,
  };
};

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
