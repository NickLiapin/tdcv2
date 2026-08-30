#!/usr/bin/env node
/**
 * A `percent=` inside a pack generator adds up to 100.
 *
 * The engine refuses a config whose shares do not — "percent values sum to 98,
 * expected 100" — and it is right to. But a pack generator's body is not read
 * until something asks for that address, so a pack shipped with 98 is a file
 * that passes every build, ships in a bundle, installs cleanly, and then fails
 * for the first person who uses it. The error names the sum and not the file.
 *
 * Measured when this check was written: `malawi/phone.txt` listed seventeen
 * operator prefixes summing to 98. It was found by rendering every address in
 * twenty-one new packs at once — not by review, and not by the sample the
 * author had checked, which had rendered that same pack successfully three
 * times through a different address.
 *
 * Only a COMPLETE literal list is checked, and that qualifier is the whole
 * subtlety. A tag may name fewer shares than it has values or cases, and then
 * the remainder goes to the last one: `<mix percent="65">` over two cases is
 * 65 and 35, and `ml/person/male/fullName.tdc` writes `percent="54.73,26.56"`
 * over three. Those are correct and the engine accepts them. It refuses only
 * when the count of shares equals the count of values and they still do not
 * reach 100 — verified against the engine before this script was written, both
 * ways round. A first draft of this check flagged the two Malayalam packs and
 * was wrong; the guard has to encode the rule, not a resemblance to it.
 *
 *   node data/scripts/check-pack-percents.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'packs');

/** Every file under `root`, depth first. */
function files(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

/** A tag carrying both a comma-listed `value=` and a literal `percent=`. */
const PAIRED = /value="([^"]*)"[^>]*?percent="([0-9.]+(?:\s*,\s*[0-9.]+)*)"/g;
const problems = [];
let checked = 0;

for (const file of files(PACKS)) {
  if (!file.endsWith('.txt') && !file.endsWith('.tdc')) continue;
  const text = readFileSync(file, 'utf8');
  if (!text.includes('percent=')) continue;
  for (const match of text.matchAll(PAIRED)) {
    const values = (match[1] ?? '').split(',').filter((v) => v.length > 0);
    const shares = (match[2] ?? '').split(',').map((s) => Number(s.trim()));
    // Fewer shares than values means the last value takes the remainder, which
    // is legal and cannot be summed to 100 by definition.
    if (values.length !== shares.length) continue;
    checked += 1;
    const total = shares.reduce((sum, n) => sum + n, 0);
    if (Math.abs(total - 100) > 1e-9) {
      problems.push(
        `${file.slice(PACKS.length + 1)}: ${String(shares.length)} shares over ` +
          `${String(values.length)} values sum to ${String(total)}, not 100`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('pack generators whose shares do not sum to 100:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${String(problems.length)} of ${String(checked)} complete percent list(s). The engine ` +
      'refuses these at render time, so the pack ships and fails for whoever uses it first.',
  );
  process.exit(1);
}

console.log(`every complete percent list in a pack sums to 100 (${String(checked)} checked)`);
