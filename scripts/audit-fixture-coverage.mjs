#!/usr/bin/env node
/**
 * Which parts of the engine no shared cross-language case ever runs.
 *
 * `fixtures/cross-language/` is what holds the five implementations to one
 * contract: a case is a config plus the bytes it must produce, and every
 * implementation runs all of them. A feature with no case is a feature the four
 * ports are free to get wrong — and will look green while doing it.
 *
 * The audit that produced this script found exactly that. `<gen type="running">`
 * had three shared cases and all three pinned `mode="memory"`, so the ROUTER was
 * never exercised; Rust sent a routed running total to the streaming engine and
 * let the refusal escape, and every suite passed. The gap was found by running
 * the DOCUMENTATION through all five, which is a slow way to discover something a
 * list can show in a second.
 *
 * ── What this can and cannot claim ───────────────────────────────────────────
 * It matches names against the fixture corpus textually, in the shape each name
 * takes in a config. So it answers "does any case so much as mention this", not
 * "is this well covered". A name it reports as missing is genuinely absent; a
 * name it reports as present may still be covered in only one shallow way — as
 * `running` was. Treat a clean run as the floor, never as proof.
 *
 * Usage:  node scripts/audit-fixture-coverage.mjs
 *         exit 0 = every name appears somewhere; exit 1 = the list
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { groups } from './engine-surface.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURES = join(ROOT, 'fixtures', 'cross-language');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.json') || p.endsWith('.tdc')) out.push(p);
  }
  return out;
}

const read = (paths) => paths.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * Two corpora, because "exercised" means two different things.
 *
 * A config in `diagnostics/` is never run — it is refused, and the file it names
 * need not exist. So a generator that appears only there has had its REFUSALS
 * pinned and its VALUES pinned by nothing. That is exactly how `type="file"`
 * came to be reported as covered while no case ever read a CSV: it was mentioned
 * four times, in four error cases.
 *
 * So each group is checked against the corpus that can actually answer for it —
 * diagnostic codes against the diagnostics, everything else against the configs
 * that produce data.
 */
const all = walk(FIXTURES);
const isDiagnostic = (f) => f.includes(`${sep}diagnostics${sep}`);
const DATA = read(all.filter((f) => !isDiagnostic(f)));
// A diagnostic is pinned in two places, and both count: `diagnostics/` holds
// config-to-code cases, and `cli.json` holds the ones only a whole command can
// raise — a pack that could not be placed, a registry that answered wrongly.
// Searching only the first reported four codes as uncovered that a CLI case had
// been pinning all along.
const CODES = read(all.filter((f) => isDiagnostic(f) || f.endsWith('cli.json')));

const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every maximal run of one letter inside a `format=` value.
 *
 * That is precisely how a date token table reads a pattern — `YYYY-MM-DD` is
 * YYYY, MM, DD — so it neither misses `DD` nor claims `D` was exercised because
 * `DD` was. Both spellings are separate tokens with separate behaviour.
 */
const dateTokensUsed = new Set(
  [...DATA.matchAll(/format=\\?"([^"\\]*)/g)].flatMap((m) => [
    // `ISO` is one token spelled with three different letters, so the run rule
    // alone splits it into I, S and O and then reports it as never exercised.
    // A whole `format=` value is a token in its own right.
    m[1],
    ...(m[1].match(/([A-Za-z])\1*/g) ?? []),
  ]),
);

/** The shape each kind of name takes where a config would use it. */
const PROBE = {
  gen: (n) => new RegExp(`type=\\\\?"${quote(n)}\\\\?"`).test(DATA),
  filter: (n) => new RegExp(`\\|${quote(n)}\\b`).test(DATA),
  compute: (n) => new RegExp(`<\\\\?/?${quote(n)}[\\s/>\\\\]`).test(DATA),
  code: (n) => CODES.includes(n),
  date: (n) => dateTokensUsed.has(n),
  dist: (n) => new RegExp(`distribution=\\\\?"${quote(n)}\\\\?"`).test(DATA),
  // An encoding is named by `<encode as="hex">`, not by an `encoding=` attribute.
  // The first version of this probe looked for the latter and reported all six as
  // uncovered, which would have sent someone to write six cases that already
  // needed writing for a different reason — and taught them not to believe the
  // next report.
  enc: (n) => new RegExp(`as=\\\\?"${quote(n)}\\\\?"`).test(DATA),
  // A function is exercised when a case CALLS it. Matching the bare name would
  // pass on any case that merely happened to contain the letters — `min` lives
  // inside `missing`, `len` inside `length` — so the open bracket is the point.
  fn: (n) => new RegExp(`\\b${quote(n)}\\s*\\(`).test(DATA),
};

/**
 * Names a shared case cannot reach, and why.
 *
 * TDC062 used to be listed here on the grounds that a shared case cannot put a
 * CSV on disk. That was wrong: `cli.json` cases carry a `files` map and always
 * could. The exemption had outlived its reason and was quietly protecting a real
 * gap, which is what every exemption eventually tries to do — so this list is
 * worth re-reading whenever the fixtures gain a capability.
 */
const DECLARED_GAPS = new Map([['TDC170', 'needs a malformed data-pack file on disk']]);

let missingTotal = 0;
const report = [];

for (const { id, title, names } of groups()) {
  const probe = PROBE[id];
  const missing = names.filter((n) => !probe(n) && !DECLARED_GAPS.has(n));
  missingTotal += missing.length;
  const mark = missing.length === 0 ? '✓' : '✗';
  console.log(`${mark} ${title}: ${String(names.length - missing.length)}/${String(names.length)}`);
  if (missing.length > 0) {
    console.log(`    no shared case: ${missing.join(', ')}`);
    report.push({ title, missing });
  }
}

if (missingTotal > 0) {
  console.log(
    `\n${String(missingTotal)} name(s) the engine implements are exercised by no shared case.\n` +
      'Add a case in fixtures/cross-language/cases/, or — if the name cannot reach a\n' +
      'config at all — narrow the extraction in scripts/engine-surface.mjs so this\n' +
      'stops claiming otherwise.',
  );
  process.exit(1);
}
for (const [name, why] of DECLARED_GAPS) console.log(`  declared gap: ${name} — ${why}`);
console.log('\nEvery name the engine implements is exercised by at least one shared case.');
