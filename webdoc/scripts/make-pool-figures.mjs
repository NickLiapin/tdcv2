/**
 * Figures for the pool page.
 *
 * Language-free by the rule in figure-kit.mjs: the drawing carries letters and
 * numbers only, and everything a reader would need translated is a latin letter
 * badge decoded by <Legend> in the page text.
 *
 * The data is real. The table on the left is produced by running the pool's own
 * derived seed (`<seed>#pool:<name>`) as an ordinary config — which is exactly
 * what the engine does — and the rows on the right come from the pool config
 * itself, so the two panels agree because the engine says they do.
 *
 * Run:  node webdoc/scripts/make-pool-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C, badge, makeRunner, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'constructs');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'pool');

mkdirSync(OUT, { recursive: true });

const SEED = 'fig';
const MEMBERS = 4;
const ROWS = 8;

const members = run(
  `<tdc><env count="${MEMBERS}" seed="${SEED}#pool:P" local="en">` +
    '<sequence name="a" uniq="true"><gen type="text" value="A,B,C,D"/></sequence>' +
    '<sequence name="b"><gen type="number" value="10..99"/></sequence>' +
    '</env><block><line><data>${{a}}|${{b}}</data></line></block></tdc>',
).map((line) => line.split('|'));

const rows = run(
  `<tdc><env count="${ROWS}" seed="${SEED}" local="en">` +
    `<pool name="P" count="${MEMBERS}">` +
    '<sequence name="a" uniq="true"><gen type="text" value="A,B,C,D"/></sequence>' +
    '<sequence name="b"><gen type="number" value="10..99"/></sequence>' +
    '</pool>' +
    '<sequence name="R"><gen type="pool" value="P"/></sequence>' +
    '</env><block><line><data>${{R.a}}|${{R.b}}</data></line></block></tdc>',
).map((line) => line.split('|'));

// Which member each row drew. The first field is unique across the pool, so the
// mapping is unambiguous — that is why the figure's first column is a uniq one.
const drawnBy = rows.map((row) => members.findIndex((m) => m[0] === row[0]));

/**
 * A pool beside the rows that read it.
 *
 * The one thing the picture has to make obvious: a row takes a whole LINE of the
 * table, never a value from one line and a value from another. So every arrow
 * leaves a member as a unit, and the two cells of a row are drawn in the colour
 * of the member they came from.
 */
function figure() {
  const W = 680;
  const cellH = 26;
  const gap = 6;
  const tableX = 40;
  const cellW = [46, 52];
  const tableW = cellW[0] + cellW[1] + 4;
  const rowsX = 430;
  const top = 44;

  const tone = ['#e0662b', '#2f9e63', '#3b82f6', '#8b5cf6'];
  const parts = [];

  // The pool: MEMBERS lines, each a member, each in its own colour.
  const tableTop = top + ((ROWS * (cellH + gap) - MEMBERS * (cellH + gap)) / 2 || 0);
  members.forEach(([a, b], i) => {
    const y = tableTop + i * (cellH + gap);
    const color = tone[i % tone.length];
    parts.push(
      `<rect x="${tableX}" y="${y}" width="${tableW}" height="${cellH}" rx="5" fill="${color}" opacity="0.16"/>`,
      `<rect x="${tableX}" y="${y}" width="${tableW}" height="${cellH}" rx="5" fill="none" stroke="${color}" opacity="0.75"/>`,
      `<line x1="${tableX + cellW[0]}" y1="${y + 4}" x2="${tableX + cellW[0]}" y2="${y + cellH - 4}" stroke="${color}" opacity="0.45"/>`,
      text(tableX + cellW[0] / 2, y + cellH / 2 + 4, a, {
        anchor: 'middle',
        fill: color,
        weight: 600,
      }),
      text(tableX + cellW[0] + cellW[1] / 2 + 2, y + cellH / 2 + 4, b, {
        anchor: 'middle',
        fill: color,
        weight: 600,
      }),
    );
  });

  // The rows: one per generated record, painted in the colour of its member.
  rows.forEach(([a, b], i) => {
    const y = top + i * (cellH + gap);
    const m = drawnBy[i];
    const color = tone[m % tone.length];
    parts.push(
      `<rect x="${rowsX}" y="${y}" width="${tableW}" height="${cellH}" rx="5" fill="${color}" opacity="0.16"/>`,
      `<rect x="${rowsX}" y="${y}" width="${tableW}" height="${cellH}" rx="5" fill="none" stroke="${color}" opacity="0.75"/>`,
      `<line x1="${rowsX + cellW[0]}" y1="${y + 4}" x2="${rowsX + cellW[0]}" y2="${y + cellH - 4}" stroke="${color}" opacity="0.45"/>`,
      text(rowsX + cellW[0] / 2, y + cellH / 2 + 4, a, {
        anchor: 'middle',
        fill: color,
        weight: 600,
      }),
      text(rowsX + cellW[0] + cellW[1] / 2 + 2, y + cellH / 2 + 4, b, {
        anchor: 'middle',
        fill: color,
        weight: 600,
      }),
    );

    // One curve per row, from the whole member to the whole row.
    const yFrom = tableTop + m * (cellH + gap) + cellH / 2;
    const yTo = y + cellH / 2;
    const x1 = tableX + tableW;
    const x2 = rowsX;
    const mid = (x1 + x2) / 2;
    parts.push(
      `<path d="M${x1},${yFrom.toFixed(1)} C${mid},${yFrom.toFixed(1)} ${mid},${yTo.toFixed(1)} ${x2},${yTo.toFixed(1)}" ` +
        `fill="none" stroke="${color}" stroke-width="1.4" opacity="0.55"/>`,
    );
  });

  const H = top + ROWS * (cellH + gap) + 18;
  parts.push(
    badge(tableX + tableW / 2, tableTop - 20, 'A', { color: C.axis }),
    badge(rowsX + tableW / 2, top - 20, 'B', { color: C.axis }),
    // C sits among the curves, because the curves are what it names.
    badge((tableX + tableW + rowsX) / 2, H - 34, 'C', { color: C.axis }),
  );

  return svg(W, H, parts.join('\n'));
}

writeFileSync(join(OUT, 'pool-member.svg'), figure());
process.stdout.write('constructs/pool-member.svg\n');
