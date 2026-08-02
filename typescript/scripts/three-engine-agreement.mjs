#!/usr/bin/env node
/**
 * Do engines 1, 2 and 3 produce the same bytes?
 *
 * Runs every shared case through all three engines and reports, per case,
 * whether they agree — and where they do not, which engine is the odd one out.
 * A case an engine legitimately refuses (percent on a uniq column, say) is
 * reported as a refusal, not as a disagreement.
 *
 *   node scripts/three-engine-agreement.mjs            # summary
 *   node scripts/three-engine-agreement.mjs --verbose  # first differing rows
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../dist/parser/index.js';
import { render } from '../dist/processor/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = resolve(here, '..', '..', 'fixtures', 'cross-language', 'cases');
const verbose = process.argv.includes('--verbose');

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

let agree = 0;
const disagree = [];
const skipped = [];

for (const file of readdirSync(cases).filter((f) => f.endsWith('.json')).sort()) {
  const { cases: list } = JSON.parse(readFileSync(resolve(cases, file), 'utf8'));
  for (const c of list ?? []) {
    const parsed = parse(c.config);
    if (parsed.diagnostics.length > 0) continue;
    const out = {};
    const refused = {};
    for (const engine of [1, 2, 3]) {
      try {
        out[engine] = render(parsed.tree, { now: NOW, engine });
      } catch (err) {
        refused[engine] = err instanceof Error ? err.message : String(err);
      }
    }
    const ran = Object.keys(out);
    if (ran.length < 2) {
      skipped.push(`${file}/${c.name} — only engine ${ran.join(',') || 'none'} ran`);
      continue;
    }
    const distinct = new Set(ran.map((e) => out[e]));
    if (distinct.size === 1) {
      agree++;
      continue;
    }
    disagree.push({ file, name: c.name, out, ran, refused });
  }
}

for (const d of disagree) {
  const groups = new Map();
  for (const e of d.ran) groups.set(d.out[e], [...(groups.get(d.out[e]) ?? []), e]);
  const shape = [...groups.values()].map((g) => `{${g.join('')}}`).join(' vs ');
  console.log(`DIFF  ${d.file}/${d.name}  ${shape}`);
  if (verbose) {
    for (const [text, engines] of groups) {
      console.log(`        {${engines.join('')}} ${JSON.stringify(text.split('\n').slice(0, 3))}`);
    }
  }
}
for (const s of skipped) console.log(`skip  ${s}`);

console.log(
  `\n${String(agree)} cases agree on every engine that ran, ` +
    `${String(disagree.length)} disagree, ${String(skipped.length)} could not be compared.`,
);
process.exitCode = disagree.length > 0 ? 1 : 0;
