/**
 * Every pack list whose body looks weighted must SAY it is weighted.
 *
 * A weighted list is `value,count` per line and needs `weighted: true` in its
 * header. Without the header the file still loads, still validates, still
 * generates — and serves "Артем,802741" as a given name. Nothing downstream
 * notices, because a name is just a string and that is a perfectly good string.
 *
 * This is the shape of bug this project keeps meeting: the config says one thing
 * and quietly gets another. So the check runs over every shipped pack rather
 * than over the one locale where it was found.
 *
 *   node data/scripts/check-weighted-headers.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'packs');

/**
 * `value,123` — a trailing integer after a comma, which is what a count is.
 *
 * The two directions of this check need DIFFERENT strictness, and using one
 * rule for both is wrong in one direction or the other.
 *
 * Reading a list that DECLARES `weighted: true`, any trailing `,digits` is the
 * count — the values themselves may well end in digits, as postal codes and
 * area codes do.
 *
 * Guessing whether a list that declares NOTHING is secretly weighted, that is
 * too loose: it fires on every income bracket written in a comma-grouping
 * currency (`Llai na £15,000`, `€75,000 sa €120,000`) and reports an honest
 * list as an undeclared weighted one. Two locale packs hit it on the same day.
 * So the guess additionally requires a non-digit before the comma, which is
 * what separates a weight delimiter from a thousands separator.
 */
const HAS_COUNT = /,\d+$/;
const LOOKS_WEIGHTED = /(^|[^\d]),\d+$/;

function everyList(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyList(full));
    else if (entry.name.endsWith('.txt')) out.push(full);
  }
  return out;
}

const files = everyList(PACKS);
const wrong = [];
let weighted = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const parts = text.split(/^---$/m);
  const header = parts[1] ?? '';
  const body = (parts[2] ?? text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (body.length === 0) continue;

  const declared = /^weighted:\s*true\s*$/m.test(header);
  // Reading a declared list, any trailing `,digits` is the count. Guessing at
  // an undeclared one, require a non-digit before the comma — see the note on
  // the two patterns above.
  const counted = body.filter((l) => (declared ? HAS_COUNT : LOOKS_WEIGHTED).test(l)).length;

  if (declared) {
    weighted++;
    // Declared weighted: EVERY line needs its count, or the load refuses.
    if (counted !== body.length) {
      wrong.push(`${relative(PACKS, file)}: declares weighted: true but ${String(body.length - counted)} line(s) carry no count`);
    }
  } else if (counted === body.length) {
    // Undeclared: the count is being served as part of the value.
    wrong.push(`${relative(PACKS, file)}: every line ends in ",<number>" but the header has no "weighted: true" — the count is part of the value`);
  }
}

if (wrong.length > 0) {
  console.error(`${String(wrong.length)} pack list(s) disagree with their header:\n`);
  for (const line of wrong) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `weighted headers agree with their bodies (${String(weighted)} weighted of ${String(files.length)} lists)`,
);
