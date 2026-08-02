/**
 * Regenerate the "пример" column of the preset tables in `presets.md`.
 *
 * The samples had drifted: `poland.tax.nip` documented `7027013633` and
 * produced `8587828006` under the very seed the page states. 136 of the 161
 * packs are built on `type="regex"`, and a fix to advanced-regex weighting moved
 * the random stream out from under all of them at once.
 *
 * There was also evidence the column had never been fully generated: the same
 * `7027013633` appeared as the sample for BOTH `poland.tax.nip` and
 * `colombia.tax.nit`, which cannot both be true — someone had copied a row.
 *
 * Hence a script rather than an edit. The column will drift again the next time
 * a generator's stream moves, and re-running this is a second, not an evening.
 *
 *   node scripts/refresh-preset-samples.mjs --check   # report drift, change nothing
 *   node scripts/refresh-preset-samples.mjs           # rewrite the column
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const PAGE = join(REPO, 'docs/user/ru/presets.md');
const CLI = join(REPO, 'typescript/dist/cli/main.js');

/** The seed and sample count the page itself declares. */
const SEED = 'demo';
const SAMPLES = 2;

const dir = mkdtempSync(join(tmpdir(), 'tdc-presets-'));

/** Run one preset and return its first `SAMPLES` values, or null if it fails. */
function sample(address) {
  const file = join(dir, 'p.tdc');
  writeFileSync(
    file,
    `<tdc><env count="${String(SAMPLES)}" seed="${SEED}" inject="\${{%}}">\n` +
      `  <sequence name="X"><gen type="template" value="${address}"/></sequence>\n` +
      `</env><block><line><data>\${{X}}</data></line></block></tdc>\n`,
  );
  try {
    const out = execFileSync(process.execPath, [CLI, file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Does the documented cell still describe what the pack produces?
 *
 * Two things the page does deliberately and a naive equality check calls drift:
 *
 *  - long values are TRUNCATED with `…` so the table fits (`b04b0159…`), and
 *  - a multi-line pack (MRZ) shows its lines as separate comma-separated
 *    entries rather than one per row.
 *
 * So compare entry by entry, treating a trailing `…` as "starts with". Getting
 * this wrong is not harmless: it was the reason a first pass reported five
 * false drifts and, earlier, why the whole page was wrongly called stale.
 */
function matchesClaim(claimed, values) {
  const want = claimed.split(',').map((s) => s.trim());
  const got = values.map((s) => s.trim());
  if (want.length > got.length) return false;
  return want.every((w, i) => {
    const g = got[i] ?? '';
    return w.endsWith('…') ? g.startsWith(w.slice(0, -1)) : w === g;
  });
}

const check = process.argv.includes('--check');
const source = readFileSync(PAGE, 'utf8');

// Table rows look like: | `address` | description | `sample, sample` |
const ROW = /^(\|\s*`([a-z0-9_.]+)`\s*\|[^|]*\|\s*)`([^`]*)`(\s*\|)$/;

let refreshed = 0;
let unchanged = 0;
let skipped = 0;
const drifted = [];

const out = source
  .split('\n')
  .map((line) => {
    const m = ROW.exec(line);
    if (!m) return line;
    const [, head, address, claimed, tail] = m;

    // Multi-line output (MRZ) has no single-line form for this column.
    const values = sample(address);
    if (!values || values.some((v) => v.includes('|'))) {
      skipped++;
      return line;
    }
    const fresh = values.join(', ');
    if (matchesClaim(claimed, values)) {
      unchanged++;
      return line;
    }
    drifted.push({ address, claimed, fresh });
    refreshed++;
    return `${head}\`${fresh}\`${tail}`;
  })
  .join('\n');

for (const d of drifted) {
  console.log(`  ${d.address}\n    was: ${d.claimed}\n    now: ${d.fresh}`);
}
console.log(
  `\n${String(unchanged)} already correct, ${String(refreshed)} drifted, ${String(skipped)} skipped`,
);

if (!check && refreshed > 0) {
  writeFileSync(PAGE, out);
  console.log('presets.md rewritten');
}

process.exit(check && refreshed > 0 ? 1 : 0);
