/**
 * The performance figures, drawn from the benchmark's own result files.
 *
 * Nothing here invents a number. Each bar is read out of `bench/results/*.json`,
 * which `bench/cli_bench.py` wrote by timing the five published command lines —
 * so a figure cannot drift from the table beside it, and re-running the benchmark
 * and re-running this is the whole update procedure.
 *
 * No words inside the SVG, per the project's figure rule: a translated page must
 * be able to reuse the same file. Categories are letter badges explained by a
 * `<Legend>` in the page; the only text is numbers, which read the same in every
 * language.
 *
 *   node webdoc/scripts/figures/performance.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const RESULTS = join(REPO, 'bench', 'results');
const OUT = join(REPO, 'webdoc', 'static', 'img', 'guides');

/** One letter per implementation, in the order the legend explains them. */
const BADGES = [
  ['crates.io', 'A'],
  ['maven', 'B'],
  ['npm', 'C'],
  ['nuget', 'D'],
  ['pypi', 'E'],
];

/** Engine 1 against the other one, told apart by fill rather than by a word. */
const COLOURS = { first: '#b0b0b4', second: '#2f9e63' };

const read = (name) => JSON.parse(readFileSync(join(RESULTS, name), 'utf8'));

/** A number a reader can take in at a glance: 3.7 / 49 / 4140, never 4140.0625. */
function short(value) {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1);
}

/**
 * Bars on a logarithmic scale, because the range demands it: peak memory across
 * one chart runs from under four megabytes to over four thousand. On a linear
 * axis every bar but the tallest would be a line one pixel high, which would
 * hide exactly the comparison the chart exists to make.
 */
function chart({ rows, title, unit }) {
  const width = 680;
  const rowHeight = 46;
  const top = 34;
  const height = top + rows.length * rowHeight + 16;
  const left = 46;
  const barLeft = left + 26;
  const barMax = width - barLeft - 78;

  const values = rows.flatMap((r) => [r.first, r.second]).filter((v) => v > 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const scale = (v) => {
    const lo = Math.log10(Math.max(min, 0.1) / 2);
    const hi = Math.log10(max * 1.15);
    return Math.max(3, ((Math.log10(Math.max(v, 0.1)) - lo) / (hi - lo)) * barMax);
  };

  const parts = [];
  rows.forEach((row, i) => {
    const y = top + i * rowHeight;
    parts.push(
      `<circle cx="${left - 12}" cy="${y + 19}" r="9.5" fill="#6b7280"/>` +
        `<text x="${left - 12}" y="${y + 23}" text-anchor="middle" font-size="12" ` +
        `font-weight="700" fill="#ffffff">${row.badge}</text>`,
    );
    for (const [key, offset] of [
      ['first', 0],
      ['second', 17],
    ]) {
      const value = row[key];
      if (!(value > 0)) continue;
      const w = scale(value);
      parts.push(
        `<rect x="${barLeft}" y="${y + offset}" width="${w.toFixed(1)}" height="14" rx="3" ` +
          `fill="${COLOURS[key]}" opacity="${key === 'first' ? '0.55' : '0.9'}"/>` +
          `<text x="${(barLeft + w + 7).toFixed(1)}" y="${y + offset + 11}" font-size="11.5" ` +
          `font-weight="600" fill="${COLOURS[key]}">${short(value)}</text>`,
      );
    }
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" ` +
    `width="${width}" height="${height}" ` +
    `font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" ` +
    `role="img" aria-label="${title}, ${unit}">` +
    parts.join('') +
    `</svg>\n`
  );
}

/** The rows of one chart: one per implementation, ordered as the badges are. */
function rowsFrom(results, tier, firstEngine, secondEngine, field) {
  return BADGES.map(([impl, badge]) => {
    const at = (engine) =>
      results.find((r) => r.implementation === impl && r.tier === tier && r.engine === engine);
    return {
      badge,
      first: at(firstEngine)?.[field] ?? 0,
      second: at(secondEngine)?.[field] ?? 0,
    };
  });
}

mkdirSync(OUT, { recursive: true });

const customers = read('cli-customers-large.json');
const uniq = read('cli-uniq-medium.json');

const figures = [
  [
    'performance-time.svg',
    chart({
      rows: rowsFrom(customers, 'large', 1, 2, 'seconds'),
      title: 'time, two million rows',
      unit: 'seconds',
    }),
  ],
  [
    'performance-memory.svg',
    chart({
      rows: rowsFrom(customers, 'large', 1, 2, 'peak_rss_mb'),
      title: 'peak memory, two million rows',
      unit: 'megabytes',
    }),
  ],
  [
    'performance-uniq.svg',
    chart({
      rows: rowsFrom(uniq, 'medium', 1, 3, 'peak_rss_mb'),
      title: 'peak memory with uniq, two hundred thousand rows',
      unit: 'megabytes',
    }),
  ],
];

for (const [name, svg] of figures) {
  writeFileSync(join(OUT, name), svg);
  console.log(`wrote ${name}`);
}
