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
import { dirname, join, resolve } from 'node:path';
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

const corpus = walk(FIXTURES)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const quote = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every maximal run of one letter inside a `format=` value.
 *
 * That is precisely how a date token table reads a pattern — `YYYY-MM-DD` is
 * YYYY, MM, DD — so it neither misses `DD` nor claims `D` was exercised because
 * `DD` was. Both spellings are separate tokens with separate behaviour.
 */
const dateTokensUsed = new Set(
  [...corpus.matchAll(/format=\\?"([^"\\]*)/g)].flatMap((m) => [
    // `ISO` is one token spelled with three different letters, so the run rule
    // alone splits it into I, S and O and then reports it as never exercised.
    // A whole `format=` value is a token in its own right.
    m[1],
    ...(m[1].match(/([A-Za-z])\1*/g) ?? []),
  ]),
);

/** The shape each kind of name takes where a config would use it. */
const PROBE = {
  gen: (n) => new RegExp(`type=\\\\?"${quote(n)}\\\\?"`).test(corpus),
  filter: (n) => new RegExp(`\\|${quote(n)}\\b`).test(corpus),
  compute: (n) => new RegExp(`<\\\\?/?${quote(n)}[\\s/>\\\\]`).test(corpus),
  code: (n) => corpus.includes(n),
  date: (n) => dateTokensUsed.has(n),
  dist: (n) => new RegExp(`distribution=\\\\?"${quote(n)}\\\\?"`).test(corpus),
  // An encoding is named by `<encode as="hex">`, not by an `encoding=` attribute.
  // The first version of this probe looked for the latter and reported all six as
  // uncovered, which would have sent someone to write six cases that already
  // needed writing for a different reason — and taught them not to believe the
  // next report.
  enc: (n) => new RegExp(`as=\\\\?"${quote(n)}\\\\?"`).test(corpus),
};

/**
 * Names a shared case cannot reach, and why.
 *
 * A shared case is a config and the bytes it produces — nothing else. Two
 * diagnostics need a FILE on disk to fire at all, and inventing a fixture format
 * that ships sample files alongside configs would be a large change to the one
 * thing five implementations agree on, to pin two error codes each of them
 * already covers in its own suite. Recorded here so the exemption is a decision
 * with a reason rather than a hole in a checklist.
 */
const DECLARED_GAPS = new Map([
  ['TDC062', 'needs a real CSV on disk to have a column= to reject'],
  ['TDC170', 'needs a malformed data-pack file on disk'],
]);

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
