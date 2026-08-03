/**
 * Collect the benchmark results into the one file the documentation reads.
 *
 * Nothing here invents a number. Every value is read out of `bench/results/*.json`,
 * which `bench/cli_bench.py` wrote by timing the five published command lines, and
 * is copied across unchanged. The page then renders that file — so a bar cannot
 * drift from the number printed beside it, and "re-run the benchmark, re-run this"
 * is the whole update procedure.
 *
 * This replaced a set of generated SVG charts. Those had to mark implementations
 * with letter badges, because a figure carries no words that a translated page
 * would need to translate — which left the reader decoding A, B, C against a
 * legend. A table has a first column, so the name can simply sit next to its bar.
 *
 *   node webdoc/scripts/figures/performance.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const RESULTS = join(REPO, 'bench', 'results');
const OUT = join(REPO, 'webdoc', 'src', 'data');

/** What each registry hands out, named as a reader thinks of it — and the
 *  registry itself spelled the way that registry spells itself. */
const IMPLEMENTATIONS = {
  'crates.io': ['Rust', 'crates.io'],
  maven: ['Java', 'Maven Central'],
  npm: ['Node.js', 'npm'],
  nuget: ['C#', 'NuGet'],
  pypi: ['Python', 'PyPI'],
};

/** Which tiers to publish, and which two engines each config was run on. */
const SOURCES = [
  { config: 'customers', tiers: ['small', 'medium', 'large'], engines: [1, 2] },
  { config: 'uniq', tiers: ['small', 'medium'], engines: [1, 3] },
];

const read = (name) => JSON.parse(readFileSync(join(RESULTS, name), 'utf8'));

/**
 * One measurement per implementation, ordered best first.
 *
 * Sorting by the first engine rather than leaving the file order alone is what
 * makes the colour ramp readable: the table shades from green at the top to red
 * at the bottom, so the ranking is visible before a single number is read.
 */
function series(rows, engines, field) {
  return Object.entries(IMPLEMENTATIONS)
    .map(([key, [name, registry]]) => ({
      name,
      registry,
      values: engines.map((engine) => {
        const hit = rows.find((r) => r.implementation === key && r.engine === engine);
        return hit && !hit.failed ? hit[field] : null;
      }),
    }))
    .sort((a, b) => (a.values[0] ?? Infinity) - (b.values[0] ?? Infinity));
}

const data = {};

for (const { config, tiers, engines } of SOURCES) {
  data[config] = {};
  for (const tier of tiers) {
    const rows = read(`cli-${config}-${tier}.json`);
    const sized = rows.filter((r) => !r.failed);
    data[config][tier] = {
      rows: rows[0].rows,
      // The output every implementation produced — they are byte-identical, which
      // the harness refuses to continue without, so any one of them is the size.
      bytes: sized.length > 0 ? sized[0].output_bytes : 0,
      engines,
      seconds: series(rows, engines, 'seconds'),
      megabytes: series(rows, engines, 'peak_rss_mb'),
    };
  }
}

mkdirSync(OUT, { recursive: true });
const path = join(OUT, 'performance.json');
writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${path}`);
