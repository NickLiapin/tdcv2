#!/usr/bin/env node
/**
 * A weighted list whose values are in alphabetical order is almost always a bug.
 *
 * `weighted: true` plus a descending curve says "the first value is the
 * commonest". Sort that same list alphabetically and the claim becomes "the
 * commonest Uzbek man's name is whichever one starts with A" — which is not a
 * fact about Uzbekistan, it is a fact about the alphabet.
 *
 * The failure is silent in every existing check. `check-weighted-headers.mjs`
 * asks whether the header agrees with the body, and it does; the values parse,
 * the counts line up, the engine draws happily. The only symptom is in the
 * output, where three consecutive rows come back Abbos, Abdulaziz, Abdulla.
 * That is how it was found: by reading generated rows, not by a guard.
 *
 * So this checks the one thing the others cannot: that a list claiming a
 * frequency ordering is not in fact ordered by something else. A pack that
 * genuinely wants an alphabetical list should simply not declare weights.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKS = process.env.TDCV2_PACKS ?? new URL('../packs', import.meta.url).pathname;

/** Lists shorter than this are too small for the ordering to mean anything. */
const MIN_VALUES = 12;
/** How much of the curve must descend before we call it a frequency claim. */
const MIN_DESCENDING = 0.8;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.txt')) out.push(full);
  }
  return out;
}

const suspects = [];
let examined = 0;

for (const file of walk(PACKS)) {
  const body = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line && !/^(---|\s*[a-z_]+:)/.test(line));

  const rows = body.map((line) => line.match(/^(.*),(\d+)\s*$/)).filter(Boolean);
  // Require the list to be overwhelmingly weighted, not merely to contain a
  // value that happens to end in a comma and digits.
  if (rows.length < MIN_VALUES || rows.length < body.length * 0.9) continue;
  examined++;

  const names = rows.map((m) => m[1]);
  const weights = rows.map((m) => Number(m[2]));

  const alphabetical = names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0);
  if (!alphabetical) continue;

  let descending = 0;
  for (let i = 1; i < weights.length; i++) if (weights[i] < weights[i - 1]) descending++;
  const ratio = descending / (weights.length - 1);
  if (ratio < MIN_DESCENDING || weights[0] <= weights[weights.length - 1]) continue;

  suspects.push({
    file: file.replace(`${PACKS}/`, ''),
    count: rows.length,
    top: names[0],
    from: weights[0],
    to: weights[weights.length - 1],
  });
}

if (suspects.length === 0) {
  console.log(`weighted lists are not alphabetically ordered (${examined} weighted lists checked)`);
  process.exit(0);
}

console.error(
  `${suspects.length} weighted list(s) are sorted ALPHABETICALLY while their weights descend.`,
);
console.error('The weights then describe the alphabet, not the language:\n');
for (const s of suspects) {
  console.error(`  ${s.file}`);
  console.error(
    `    ${s.count} values, weights ${s.from} -> ${s.to}, so "${s.top}" is claimed to be the commonest`,
  );
}
console.error('\nEither order the list by frequency, or drop the weights.');
process.exit(1);
