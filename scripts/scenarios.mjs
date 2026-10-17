#!/usr/bin/env node
/**
 * Whole, realistic configs, run end to end in all five implementations.
 *
 * A shared case pins one behaviour in a few rows. A scenario is a config somebody actually
 * wrote for a real purpose — tens of thousands of records, a dozen pools, most of the language
 * at once — and the only claim it makes is that all five print the same bytes, and that those are
 * the bytes recorded beside it. The first is the hospital a plugin agent built in October 2026.
 * Run through the other four for the first time, it found that none of them could open it (a
 * `<switch>` on a pool field, an offset measured from one), that their in-memory engines dropped
 * `repeat=` inside a branch, and that the reference moved every February 29 to March 1 — four
 * bugs no shared case had touched, each now pinned by a case of its own.
 *
 * It needs the command lines built from this checkout (see `five-clis.mjs`), which is why it is
 * a step before a release rather than part of `npm run check`. About two minutes for all five.
 *
 *   node scripts/scenarios.mjs                    # all five
 *   node scripts/scenarios.mjs --only typescript  # some of them
 *   node scripts/scenarios.mjs --update           # re-record the hashes from the reference
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO } from "./doc-examples.mjs";
import { chosenImplementations } from "./five-clis.mjs";

const DIR = join(REPO, "fixtures/cross-language/scenarios");
const INDEX = join(DIR, "scenarios.json");

const args = process.argv.slice(2);
const update = args.includes("--update");
const onlyAt = args.indexOf("--only");
const only = update
  ? new Set(["typescript"])
  : onlyAt === -1
    ? null
    : new Set(args[onlyAt + 1].split(","));
const chosen = chosenImplementations(only);

const index = JSON.parse(readFileSync(INDEX, "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "tdc-scenarios-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

/** One run: the output's hash, size and line count, or the reason there is none. */
function run(impl, config) {
  const out = join(scratch, `${impl.id}.out`);
  const [command, prefix] = impl.command;
  const started = Date.now();
  try {
    execFileSync(command, [...prefix, config, "-o", out], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const detail = String(err.stderr || err.message).trim();
    return { failed: detail.split("\n").slice(0, 3).join("\n") };
  }
  const bytes = readFileSync(out);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    lines: bytes.toString("utf8").split("\n").length - 1,
    seconds: (Date.now() - started) / 1000,
  };
}

let failures = 0;
for (const scenario of index.scenarios) {
  const config = join(DIR, scenario.file);
  console.log(`${scenario.file} — ${scenario.title}`);
  for (const impl of chosen) {
    const got = run(impl, config);
    if (got.failed !== undefined) {
      failures += 1;
      console.log(
        `  ✗ ${impl.label}: did not run\n      ${got.failed.replaceAll("\n", "\n      ")}`,
      );
      continue;
    }
    if (update) {
      Object.assign(scenario, {
        sha256: got.sha256,
        bytes: got.bytes,
        lines: got.lines,
      });
      console.log(
        `  recorded ${got.sha256.slice(0, 16)}… (${String(got.lines)} lines)`,
      );
      continue;
    }
    const same = got.sha256 === scenario.sha256;
    if (!same) failures += 1;
    console.log(
      `  ${same ? "✓" : "✗"} ${impl.label.padEnd(24)} ${got.seconds.toFixed(1).padStart(6)} s` +
        (same
          ? ""
          : `  ${got.sha256.slice(0, 16)}… ≠ ${scenario.sha256.slice(0, 16)}…`),
    );
  }
}
if (update) writeFileSync(INDEX, JSON.stringify(index, null, 2) + "\n");
process.exit(failures === 0 ? 0 : 1);
