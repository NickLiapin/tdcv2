/**
 * Figures for the "a signal built from formulas" guide.
 *
 * Language-free by the rule in figure-kit.mjs. What makes this page unusual is
 * that its subject is a SHAPE, so the figures carry no data labels at all — only
 * numbers on the axes, which every language reads the same, and letter badges
 * the page decodes through <Legend>.
 *
 * Every value comes from running the real CLI on the very config the page
 * prints. A drawing of a heartbeat is exactly the kind of figure an author would
 * be tempted to draw by hand until it looked right; then the page would be
 * showing an artist's impression of the engine rather than the engine.
 *
 * Run:  node webdoc/scripts/make-signal-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C, badge, makeRunner, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'guides');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'signal');

mkdirSync(OUT, { recursive: true });

const W = 680;

/** The waves, exactly as the guide prints them: height, centre in ms, half-width. */
const WAVES = [
  ['P', 0.12, 200, 22],
  ['Q', -0.16, 372, 10],
  ['R', 1.2, 400, 8],
  ['S', -0.28, 428, 12],
  ['T', 0.35, 620, 45],
];

const bell = ([, a, mu, sd]) => `${a} * exp(-pow((Phase - ${mu}) / ${sd}, 2))`;

/** The guide's config, with the columns a figure needs added to the output. */
function config(count, columns) {
  return (
    `<tdc><env count="${count}" seed="ecg">` +
    '<sequence name="T"><gen type="formula" expr="(_count - 1) * 4"/></sequence>' +
    '<sequence name="N"><gen type="formula" expr="floor(T / 1000)"/></sequence>' +
    '<sequence name="Onset"><gen type="formula" expr="N * 1000 + 45 * sin(N * 1.7)"/></sequence>' +
    '<sequence name="Phase"><gen type="formula" expr="T - Onset"/></sequence>' +
    '<sequence name="Amp"><gen type="formula" expr="1.20 + 0.07 * sin(N * 2.3)"/></sequence>' +
    WAVES.map(
      (w) =>
        `<sequence name="W${w[0]}"><gen type="formula" expr="${
          w[0] === 'R' ? `Amp * exp(-pow((Phase - 400) / 8, 2))` : bell(w)
        }" decimals="4"/></sequence>`,
    ).join('') +
    '<sequence name="Drift"><gen type="formula" expr="0.05 * sin(_count / 95)"/></sequence>' +
    '<sequence name="Noise"><gen type="number" distribution="normal" mean="0" sd="0.012" decimals="4"/></sequence>' +
    '<sequence name="X"><gen type="formula" expr="T / 1000" decimals="3"/></sequence>' +
    '<sequence name="Y"><gen type="formula" expr="WP + WQ + WR + WS + WT + Drift + Noise" decimals="4"/></sequence>' +
    '</env><block><line><data>' +
    columns.map((c) => `\${{${c}}}`).join(',') +
    '</data></line></block></tdc>'
  );
}

const rows = (count, columns) =>
  run(config(count, columns)).map((line) => line.split(',').map(Number));

/** ECG paper: a warm grid that stays visible on both themes because it is faint. */
function paper(x, y, w, h, fine, bold) {
  const parts = [];
  for (let gx = x; gx <= x + w + 0.01; gx += fine) {
    const heavy = Math.abs((gx - x) / bold - Math.round((gx - x) / bold)) < 1e-6;
    parts.push(
      `<line x1="${gx.toFixed(1)}" y1="${y}" x2="${gx.toFixed(1)}" y2="${y + h}" stroke="${C.drawn}" stroke-width="${heavy ? 0.9 : 0.4}" opacity="${heavy ? 0.34 : 0.16}"/>`,
    );
  }
  for (let gy = y; gy <= y + h + 0.01; gy += fine) {
    const heavy = Math.abs((gy - y) / bold - Math.round((gy - y) / bold)) < 1e-6;
    parts.push(
      `<line x1="${x}" y1="${gy.toFixed(1)}" x2="${x + w}" y2="${gy.toFixed(1)}" stroke="${C.drawn}" stroke-width="${heavy ? 0.9 : 0.4}" opacity="${heavy ? 0.34 : 0.16}"/>`,
    );
  }
  return parts.join('');
}

const path = (pts) => pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');

// --------------------------------------------------- 1. one beat, taken apart

/**
 * The construction, in one picture: five bells added together make a heartbeat.
 * Each bell is faint and badged; the sum is the strong line, and it is the only
 * thing the config actually prints.
 */
function anatomy() {
  const data = rows(250, ['Phase', 'WP', 'WQ', 'WR', 'WS', 'WT', 'Y']);
  const L = 52;
  const R = 22;
  const TOP = 16;
  const H = 210;
  const sx = (ms) => L + (ms / 1000) * (W - L - R);
  const sy = (mv) => TOP + H - ((mv + 0.45) / 1.85) * H;

  const parts = [
    `<line x1="${L}" y1="${sy(0).toFixed(1)}" x2="${W - R}" y2="${sy(0).toFixed(1)}" stroke="${C.axis}" stroke-width="1" opacity="0.45"/>`,
  ];

  for (const mv of [1.0, 0.5, 0, -0.25]) {
    parts.push(text(L - 8, sy(mv) + 4, mv.toFixed(2), { anchor: 'end', size: 10 }));
  }
  for (const ms of [0, 200, 400, 600, 800, 1000]) {
    parts.push(text(sx(ms), TOP + H + 18, String(ms), { anchor: 'middle', size: 10 }));
  }

  // The five parts, each in the faint colour: they are inputs, not the answer.
  WAVES.forEach((w, i) => {
    const pts = data.map((r) => [sx(r[0]), sy(r[1 + i])]);
    parts.push(
      `<polyline points="${path(pts)}" fill="none" stroke="${C.faint}" stroke-width="1.3" opacity="0.9"/>`,
    );
  });

  parts.push(
    `<polyline points="${path(data.map((r) => [sx(r[0]), sy(r[6])]))}" fill="none" stroke="${C.made}" stroke-width="2" stroke-linejoin="round"/>`,
  );

  // A badge sits beside each bell's peak, clear of the summed line.
  const at = [
    ['A', 200, 0.12, -22],
    ['B', 372, -0.16, -20],
    ['C', 400, 1.2, 16],
    ['D', 428, -0.28, -20],
    ['E', 620, 0.35, 20],
  ];
  for (const [letter, ms, mv, dy] of at) {
    parts.push(badge(sx(ms) + (letter === 'B' ? -14 : letter === 'D' ? 14 : 0), sy(mv) - dy, letter));
  }

  return svg(W, TOP + H + 30, parts.join('\n'));
}

// ------------------------------------------------------- 2. the printed strip

/**
 * Five seconds as a reader would see them on paper. The dashed verticals are
 * whole seconds; the spikes deliberately miss them, which is the only way to
 * show on a still image that the beats are not on a fixed grid.
 */
function strip() {
  const data = rows(1250, ['X', 'Y']);
  const L = 10;
  const R = 10;
  const TOP = 10;
  const H = 200;
  const sx = (s) => L + (s / 5) * (W - L - R);
  const sy = (mv) => TOP + H * 0.56 - mv * 88;

  const parts = [paper(L, TOP, W - L - R, H, 8.9, 44.5)];
  parts.push(
    `<line x1="${L}" y1="${sy(0).toFixed(1)}" x2="${W - R}" y2="${sy(0).toFixed(1)}" stroke="${C.axis}" stroke-width="0.8" opacity="0.5"/>`,
  );

  for (const s of [1, 2, 3, 4]) {
    parts.push(
      `<line x1="${sx(s).toFixed(1)}" y1="${TOP}" x2="${sx(s).toFixed(1)}" y2="${TOP + H}" stroke="${C.mark}" stroke-width="1.1" stroke-dasharray="3 4" opacity="0.75"/>`,
      text(sx(s), TOP + H + 17, String(s), { anchor: 'middle', size: 10 }),
    );
  }

  parts.push(
    `<polyline points="${path(data.map((r) => [sx(r[0]), sy(r[1])]))}" fill="none" stroke="${C.made}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`,
  );

  // The gap a reader is meant to notice: the fourth spike against the third second.
  const peaks = data.filter(
    (r, i) => i > 0 && i < data.length - 1 && r[1] > 0.8 && r[1] >= data[i - 1][1] && r[1] > data[i + 1][1],
  );
  // Beside the spike, not above it: at 1.2 mV the peak is already within a few
  // pixels of the top edge, and a badge there would be half outside the drawing.
  const late = peaks[3];
  parts.push(badge(sx(3), TOP + 14, 'A'), badge(sx(late[0]) + 17, sy(late[1] * 0.62), 'B'));

  return svg(W, TOP + H + 28, parts.join('\n'));
}

for (const [name, make] of [
  ['ecg-anatomy', anatomy],
  ['ecg-strip', strip],
]) {
  writeFileSync(join(OUT, `${name}.svg`), make());
  console.log(`  ${name}.svg`);
}
