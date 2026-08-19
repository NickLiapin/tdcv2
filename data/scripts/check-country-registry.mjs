#!/usr/bin/env node
/**
 * Keep the canonical country list current. It is a reference, not a gate.
 *
 * It USED to be a gate, and only in TypeScript: a country's first address
 * segment was checked against `CANONICAL_COUNTRIES` in
 * `typescript/src/data-pack/locales.ts`, so a directory missing from that list
 * warned TDC171 on load and every config asking for it failed with "unknown
 * template path" — a whole pack in the repository, reachable by nobody. Four
 * country packs were written into that state in a single afternoon, which is
 * why this check exists.
 *
 * The header used to say the four ports needed no equivalent because they ask
 * the pack source whether the directory exists. That was the right observation
 * and the wrong conclusion: the fix was not to keep one implementation's list
 * in sync, it was to stop gating on a list at all. TypeScript now resolves a
 * country the way the other four always did, so a new directory is addressable
 * the moment it is written, in all five, with no release.
 *
 * What the list is still for: `resolvePackAddress` consults it when nothing has
 * been scanned yet, and the pack picker reads its geography. Both are better
 * with it current, and `--update` costs one command — so this still fails,
 * loudly, rather than letting it rot.
 *
 *   node data/scripts/check-country-registry.mjs            fail on any unregistered country
 *   node data/scripts/check-country-registry.mjs --update    add the missing entries
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const COUNTRIES_DIR = join(ROOT, "data", "packs", "countries");
const LOCALES_TS = join(ROOT, "typescript", "src", "data-pack", "locales.ts");

/** The exact text span of the CANONICAL_COUNTRIES set literal. */
function countrySetSpan(source) {
  const declaration =
    "export const CANONICAL_COUNTRIES: ReadonlySet<string> = new Set([";
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`cannot find CANONICAL_COUNTRIES in ${LOCALES_TS}`);
  }
  const open = start + declaration.length;
  const close = source.indexOf("]);", open);
  if (close === -1) {
    throw new Error(
      `CANONICAL_COUNTRIES in ${LOCALES_TS} is not closed with "]);"`,
    );
  }
  return { open, close };
}

const source = readFileSync(LOCALES_TS, "utf8");
const { open, close } = countrySetSpan(source);
const registered = new Set(
  [...source.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
);

const onDisk = readdirSync(COUNTRIES_DIR)
  .filter((name) => statSync(join(COUNTRIES_DIR, name)).isDirectory())
  .sort();

const unregistered = onDisk.filter((name) => !registered.has(name));
const phantom = [...registered].filter((name) => !onDisk.includes(name)).sort();

if (process.argv.includes("--update")) {
  const merged = [...new Set([...registered, ...onDisk])].sort();
  const body = merged.map((name) => `\n  '${name}',`).join("");
  writeFileSync(
    LOCALES_TS,
    `${source.slice(0, open)}${body}\n${source.slice(close)}`,
  );
  console.log(
    `CANONICAL_COUNTRIES: added ${String(unregistered.length)} — ` +
      `${unregistered.join(", ") || "nothing"}`,
  );
  process.exit(0);
}

let failed = false;
if (unregistered.length > 0) {
  failed = true;
  console.error(
    `${String(unregistered.length)} country pack(s) are missing from the reference list — ` +
      "no entry in CANONICAL_COUNTRIES:\n" +
      `  ${unregistered.join(", ")}\n` +
      "They still WORK — a directory under countries/ is addressable by being there.\n" +
      "But the list feeds address resolution before anything is scanned, and the\n" +
      "picker's map reads its geography, so a gap in it is a gap in both.\n" +
      "Run `node data/scripts/check-country-registry.mjs --update` and commit the result.",
  );
}
if (phantom.length > 0) {
  failed = true;
  console.error(
    `${String(phantom.length)} country name(s) are registered with no pack on disk:\n` +
      `  ${phantom.join(", ")}\n` +
      "Either the directory was renamed, or the entry is a typo that will never match.",
  );
}
if (failed) process.exit(1);

console.log(
  `the country reference list is current: ${String(onDisk.length)} directories, ` +
    "all present in CANONICAL_COUNTRIES",
);
