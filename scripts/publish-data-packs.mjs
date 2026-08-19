#!/usr/bin/env node
/**
 * Publish the data-pack bundles, and never let the registry's README lie again.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The bundles live in a separate public repository. Publishing was a runbook —
 * build, clone, copy, verify, push — and every step of it was done. The README
 * beside the bundles was not, because it was not a step. So the catalogue page
 * said "108 bundles: common, 10 languages, 97 countries" for three weeks while
 * the directory next to it held 239, and the first person to notice was the
 * maintainer looking at his own repository front page.
 *
 * That is the same failure this project keeps meeting: a thing that says it is
 * one way and is another, with nothing tying the statement to the fact. The
 * documentation site already solved it — its counts are placeholders filled in
 * from the manifest at build time and cannot drift. This does the same for the
 * registry README: the numbers are DERIVED from index.json, never typed.
 *
 *   node scripts/publish-data-packs.mjs --check
 *       Ask the live registry whether its README agrees with its own index.
 *       Needs no clone. This is the check to run when in doubt.
 *
 *   node scripts/publish-data-packs.mjs --prepare <clone>
 *       Copy this build into a clone of the registry, rewrite the README's
 *       derived numbers, verify every hash with an independent digest, and
 *       print the diff for a human. It does not commit and does not push:
 *       publishing is outward-facing and stays a deliberate act.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build", "data-packs");
const RAW =
  "https://raw.githubusercontent.com/NickLiapin/tdcv2-data-packs/master";

/** The one place the numbers come from. Everything else quotes this. */
function countsOf(index) {
  const bundles = index.bundles;
  const countries = bundles.filter((b) => b.country).length;
  return {
    sets: bundles.length,
    countries,
    languages: bundles.length - countries - 1,
  };
}

/**
 * The README sentence that states the catalogue's size, and the one that states
 * how many implementations read it. Both are facts about the repository, so both
 * are rewritten rather than trusted.
 */
const CATALOGUE =
  /\*\*\d+ bundles: `common`, \d+ languages, \d+ countries\.\*\*/;

function rewriteReadme(text, counts) {
  if (!CATALOGUE.test(text)) {
    throw new Error(
      "the README no longer contains the catalogue sentence this script rewrites.\n" +
        "It was reworded, so the numbers are untied again. Restore a line matching\n" +
        "  **<n> bundles: `common`, <n> languages, <n> countries.**\n" +
        "or update the pattern here — but do not leave it typed by hand.",
    );
  }
  return text.replace(
    CATALOGUE,
    `**${String(counts.sets)} bundles: \`common\`, ${String(counts.languages)} languages, ` +
      `${String(counts.countries)} countries.**`,
  );
}

async function check() {
  const [indexText, readme] = await Promise.all(
    [`${RAW}/index.json`, `${RAW}/README.md`].map(async (u) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`${u} answered ${String(r.status)}`);
      return r.text();
    }),
  );
  const counts = countsOf(JSON.parse(indexText));
  const said =
    /\*\*(\d+) bundles: `common`, (\d+) languages, (\d+) countries\.\*\*/.exec(
      readme,
    );
  if (!said) {
    console.error("the published README has no catalogue sentence to check.");
    process.exit(1);
  }
  const [, sets, languages, countries] = said;
  const ok =
    Number(sets) === counts.sets &&
    Number(languages) === counts.languages &&
    Number(countries) === counts.countries;
  console.log(
    `published index : ${String(counts.sets)} sets, ${String(counts.languages)} languages, ${String(counts.countries)} countries`,
  );
  console.log(
    `published README: ${sets} sets, ${languages} languages, ${countries} countries`,
  );
  if (!ok) {
    console.error(
      "\nThe README beside the bundles describes a different catalogue than the one\n" +
        "it ships. Re-run the prepare step and push the README with the bundles.",
    );
    process.exit(1);
  }
  console.log("\nthe registry README agrees with the registry index");
}

function prepare(clone) {
  if (!existsSync(join(BUILD, "index.json"))) {
    throw new Error(
      `no build at ${BUILD} — run: node typescript/scripts/build-data-packs.mjs`,
    );
  }
  if (!existsSync(join(clone, "README.md"))) {
    throw new Error(
      `${clone} does not look like a clone of the registry (no README.md)`,
    );
  }
  const index = JSON.parse(readFileSync(join(BUILD, "index.json"), "utf8"));
  const counts = countsOf(index);

  // 1. the payload
  mkdirSync(join(clone, "bundles"), { recursive: true });
  copyFileSync(join(BUILD, "index.json"), join(clone, "index.json"));
  for (const f of readdirSync(join(BUILD, "bundles"))) {
    copyFileSync(join(BUILD, "bundles", f), join(clone, "bundles", f));
  }

  // 2. the README — derived, so it cannot fall behind the payload it describes
  const readme = join(clone, "README.md");
  writeFileSync(readme, rewriteReadme(readFileSync(readme, "utf8"), counts));

  // 3. verify every hash against the zip, with a digest this build did not write
  let bad = 0;
  for (const b of index.bundles) {
    const p = join(clone, "bundles", `${b.id}.zip`);
    if (!existsSync(p)) {
      console.error(`  MISSING ZIP: ${b.id}`);
      bad++;
      continue;
    }
    const bytes = readFileSync(p);
    if (createHash("sha256").update(bytes).digest("hex") !== b.sha256) {
      console.error(`  SHA MISMATCH: ${b.id}`);
      bad++;
    }
    if (b.bytes !== undefined && bytes.length !== b.bytes) {
      console.error(`  BYTES MISMATCH: ${b.id}`);
      bad++;
    }
  }
  if (bad > 0) {
    console.error(
      `\n${String(bad)} integrity problem(s) — nothing is fit to publish.`,
    );
    process.exit(1);
  }

  console.log(
    `staged ${String(counts.sets)} bundles into ${clone}\n` +
      `  ${String(counts.languages)} languages, ${String(counts.countries)} countries, ` +
      "every sha256 and byte count re-verified\n" +
      "  README catalogue line rewritten from the index\n\n" +
      "Review `git -C <clone> status --short` and the diff, then commit and push there.",
  );
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  await check();
} else if (args.includes("--prepare")) {
  const clone = args[args.indexOf("--prepare") + 1];
  if (!clone)
    throw new Error("--prepare needs the path to a clone of the registry");
  prepare(clone);
} else {
  console.error("usage: publish-data-packs.mjs --check | --prepare <clone>");
  process.exit(2);
}
