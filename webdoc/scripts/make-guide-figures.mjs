/**
 * Figures for the intro and the guides.
 *
 * Language-free by the rule in figure-kit.mjs: numbers and code spellings may
 * live inside a drawing, everything else is a latin letter badge that the page
 * text decodes through <Legend>. Where a figure shows data, that data comes from
 * running the real CLI — the values are latin letters on purpose, so a figure
 * about hierarchy is not secretly a figure about English city names.
 *
 * Run:  node webdoc/scripts/make-guide-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARROW, C, badge, box, dots, frame, makeRunner, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'guides');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'guides');

mkdirSync(OUT, { recursive: true });

const W = 680;
const PAD_L = 60;
const PAD_R = 30;
const TOP = 18;

const FIGURES = {};

// ------------------------------------------------------------ 1. the pipeline

/**
 * What TDC is, in one picture: one config, one engine, as many rows as asked
 * for. Drawn rather than written because the intro page otherwise opens with a
 * wall of XML.
 */
FIGURES['pipeline'] = () => {
  const y = 46;
  const h = 96;
  const doc = { x: 60, y, w: 150, h };
  const eng = { x: 265, y, w: 150, h };
  const out = { x: 470, y, w: 150, h };
  const card = (r, extra = '') =>
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="${C.axis}" opacity="0.1"/>` +
    `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="10" fill="none" stroke="${C.axis}" opacity="0.5"/>` +
    extra;

  // A config: a few lines of "text" on a page.
  const configLines = [0, 1, 2, 3]
    .map(
      (i) =>
        `<rect x="${doc.x + 22}" y="${doc.y + 24 + i * 14}" width="${[70, 96, 84, 52][i]}" height="5" rx="2.5" fill="${C.drawn}" opacity="${0.85 - i * 0.12}"/>`,
    )
    .join('');
  // The engine: a seed feeding a deterministic wheel.
  const wheel =
    `<circle cx="${eng.x + eng.w / 2}" cy="${eng.y + eng.h / 2}" r="26" fill="none" stroke="${C.mark}" stroke-width="3"/>` +
    `<circle cx="${eng.x + eng.w / 2}" cy="${eng.y + eng.h / 2}" r="5" fill="${C.mark}"/>` +
    [0, 60, 120, 180, 240, 300]
      .map((a) => {
        const r = (a * Math.PI) / 180;
        const cx = eng.x + eng.w / 2;
        const cy = eng.y + eng.h / 2;
        return `<line x1="${(cx + 12 * Math.cos(r)).toFixed(1)}" y1="${(cy + 12 * Math.sin(r)).toFixed(1)}" x2="${(cx + 26 * Math.cos(r)).toFixed(1)}" y2="${(cy + 26 * Math.sin(r)).toFixed(1)}" stroke="${C.mark}" stroke-width="2" opacity="0.55"/>`;
      })
      .join('');
  // The output: rows, more of them than fit, trailing off.
  const rows = Array.from({ length: 6 }, (_, i) => {
    const o = 1 - i * 0.14;
    return (
      `<rect x="${out.x + 20}" y="${out.y + 16 + i * 12}" width="34" height="6" rx="3" fill="${C.made}" opacity="${o}"/>` +
      `<rect x="${out.x + 60}" y="${out.y + 16 + i * 12}" width="26" height="6" rx="3" fill="${C.made}" opacity="${o * 0.75}"/>` +
      `<rect x="${out.x + 92}" y="${out.y + 16 + i * 12}" width="18" height="6" rx="3" fill="${C.made}" opacity="${o * 0.55}"/>`
    );
  }).join('');

  const arrow = (x1, x2) =>
    `<line x1="${x1}" y1="${y + h / 2}" x2="${x2}" y2="${y + h / 2}" stroke="${C.axis}" stroke-width="2" marker-end="url(#a)" opacity="0.8"/>`;

  return svg(
    W,
    200,
    [
      ARROW.replace(`fill="${C.mark}"`, `fill="${C.axis}"`),
      card(doc, configLines),
      card(eng, wheel),
      card(out, rows),
      arrow(doc.x + doc.w + 8, eng.x - 10),
      arrow(eng.x + eng.w + 8, out.x - 10),
      badge(doc.x + 16, doc.y + 14, 'A'),
      badge(eng.x + 16, eng.y + 14, 'B'),
      badge(out.x + 16, out.y + 14, 'C'),
      // The one number that matters here: the row count is unbounded.
      text(out.x + out.w / 2, out.y + out.h + 26, '1 … 1 000 000 …', {
        anchor: 'middle',
        size: 12,
      }),
    ].join('\n'),
  );
};

// -------------------------------------------------- 2. parent → child linkage

/**
 * Hierarchy, with values that are single latin letters so the picture stays
 * language-free: parent P takes A or B, and each parent value has its own child
 * alphabet. Real output, 40 rows.
 */
FIGURES['parent-child'] = () => {
  const rows = run(
    `<tdc><env count="40" seed="doc">
      <sequence name="P"><gen type="text" value="A,B" percent="50,50"/></sequence>
      <sequence name="CA" parent="P.A"><gen type="text" value="1,2,3"/></sequence>
      <sequence name="CB" parent="P.B"><gen type="text" value="7,8"/></sequence>
    </env><block><line><data>\${{P}}\${{CA}}\${{CB}}</data></line></block></tdc>`,
  );
  const cell = 26;
  const cols = 20;
  const x0 = PAD_L;
  const y0 = TOP + 34;
  const grid = rows
    .map((r, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = x0 + col * (cell + 4);
      const y = y0 + row * (cell + 26);
      const isA = r[0] === 'A';
      const colour = isA ? C.drawn : C.alt;
      return (
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="5" fill="${colour}" opacity="0.85"/>` +
        `<text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${r[0]}</text>` +
        `<text x="${x + cell / 2}" y="${y + cell + 15}" text-anchor="middle" font-size="12" fill="${colour}">${r[1]}</text>`
      );
    })
    .join('');
  // No badges here: the colour of a cell is the key, and the values inside it are
  // already latin characters, so the picture explains itself once the legend does.
  return svg(W, y0 + 2 * (cell + 26) + 10, grid);
};

// ------------------------------------------------------- 3. mix, exact shares

/** Declared percentages against the counts actually produced. */
FIGURES['mix-percent'] = () => {
  const N = 1000;
  const rows = run(
    `<tdc><env count="${N}" seed="doc">
      <mix name="M" percent="55,30,15">
        <case><gen type="text" value="A"/></case>
        <case><gen type="text" value="B"/></case>
        <case><gen type="text" value="C"/></case>
      </mix>
    </env><block><line><data>\${{M}}</data></line></block></tdc>`,
  );
  const declared = [55, 30, 15];
  const actual = ['A', 'B', 'C'].map(
    (k) => Math.round((rows.filter((r) => r === k).length / N) * 1000) / 10,
  );
  const b = box(PAD_L + 30, TOP + 6, 480, 150, [0, 60]);
  const groupW = b.w / 3;
  const bars = declared
    .map((d, i) => {
      const gx = b.x + i * groupW;
      const bw = 54;
      const gap = 16;
      const left = gx + groupW / 2 - bw - gap / 2;
      const right = gx + groupW / 2 + gap / 2;
      const bar = (x, v, color, op) =>
        `<rect x="${x}" y="${b.sy(v).toFixed(1)}" width="${bw}" height="${(b.y + b.h - b.sy(v)).toFixed(1)}" rx="3" fill="${color}" opacity="${op}"/>` +
        text(x + bw / 2, b.sy(v) - 6, v.toFixed(v % 1 === 0 ? 0 : 1), { anchor: 'middle' });
      return (
        bar(left, d, C.drawn, 0.55) +
        bar(right, actual[i], C.made, 0.85) +
        // The case label is its generated value: a latin letter, not a word.
        text(gx + groupW / 2, b.y + b.h + 20, ['A', 'B', 'C'][i], {
          anchor: 'middle',
          size: 13,
          weight: 700,
        })
      );
    })
    .join('');
  return svg(
    W,
    b.y + b.h + 44,
    [frame(b, { yTicks: [0, 20, 40, 60] }), bars, text(b.x, TOP - 4, `n = ${N}`)].join('\n'),
  );
};

// ------------------------------------------------------------ 4. determinism

/** Two runs on one seed, and a third on another: same input, same output. */
FIGURES['determinism'] = () => {
  const series = (seed) =>
    run(
      `<tdc><env count="60" seed="${seed}"><sequence name="V"><gen type="number" value="0..100"/></sequence></env>` +
        `<block><line><data>\${{V}}</data></line></block></tdc>`,
    ).map(Number);
  const a1 = series('alpha');
  const a2 = series('alpha');
  const b1 = series('beta');
  const panels = [
    [a1, C.made, 'A'],
    [a2, C.made, 'B'],
    [b1, C.alt, 'C'],
  ].map(([vals, color, letter], i) => {
    const b = box(PAD_L, TOP + i * 78, W - PAD_L - PAD_R, 56);
    return [
      frame(b, { yTicks: [0, 100], yLabels: i === 2 }),
      dots(b, vals, { color, r: 2.6 }),
      badge(b.x - 34, b.y + 28, letter),
    ].join('\n');
  });
  return svg(W, TOP + 3 * 78 + 10, panels.join('\n'));
};

// ------------------------------------------- 5. anomalies and missing values

/** A clean series, the same series with outliers, and with holes punched in it. */
FIGURES['anomalies-missing'] = () => {
  const N = 80;
  const clean = run(
    `<tdc><env count="${N}" seed="doc"><sequence name="V"><gen type="number" distribution="normal" mean="50" sd="8"/></sequence></env>` +
      `<block><line><data>\${{V}}</data></line></block></tdc>`,
  ).map(Number);
  const withAnomalies = run(
    `<tdc><env count="${N}" seed="doc"><sequence name="V"><gen type="number" distribution="normal" mean="50" sd="8" anomaly="0.06" anomaly_factor="3"/></sequence></env>` +
      `<block><line><data>\${{V}}</data></line></block></tdc>`,
  ).map(Number);
  // A blank value would come back as an empty line and be dropped, taking the very
  // holes this figure is about with it — so every row carries a trailing marker.
  const withMissing = run(
    `<tdc><env count="${N}" seed="doc"><sequence name="V"><gen type="number" distribution="normal" mean="50" sd="8" missing="0.15"/></sequence></env>` +
      `<block><line><data>\${{V}}|</data></line></block></tdc>`,
  ).map((s) => s.slice(0, -1));

  const dom = [0, Math.max(...withAnomalies) * 1.05];
  const rowsY = (i) => TOP + i * 96;
  const panels = [];

  const top = box(PAD_L, rowsY(0), W - PAD_L - PAD_R, 74, dom);
  panels.push(
    frame(top, { yTicks: [0, Math.round(dom[1])] }),
    dots(top, clean, { r: 2.4 }),
    badge(top.x - 34, top.y + 37, 'A'),
  );

  const mid = box(PAD_L, rowsY(1), W - PAD_L - PAD_R, 74, dom);
  const isOut = withAnomalies.map((v, i) => Math.abs(v - (clean[i] ?? v)) > 1e-9);
  panels.push(
    frame(mid, { yTicks: [0, Math.round(dom[1])] }),
    dots(
      mid,
      withAnomalies.map((v, i) => (isOut[i] ? dom[0] - 1000 : v)),
      { r: 2.4 },
    ),
    withAnomalies
      .map((v, i) =>
        isOut[i]
          ? `<circle cx="${mid.sx(i / (N - 1)).toFixed(1)}" cy="${mid.sy(v).toFixed(1)}" r="4.6" fill="${C.mark}"/>`
          : '',
      )
      .join(''),
    badge(mid.x - 34, mid.y + 37, 'B'),
  );

  const bot = box(PAD_L, rowsY(2), W - PAD_L - PAD_R, 74, dom);
  panels.push(
    frame(bot, { yTicks: [0, Math.round(dom[1])] }),
    withMissing
      .map((raw, i) => {
        const x = bot.sx(i / (N - 1));
        if (raw.trim() === '') {
          // A hole is drawn as a gap marker on the floor, not as a value of zero.
          return `<line x1="${x.toFixed(1)}" y1="${(bot.y + bot.h - 5).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(bot.y + bot.h + 5).toFixed(1)}" stroke="${C.faint}" stroke-width="2"/>`;
        }
        return `<circle cx="${x.toFixed(1)}" cy="${bot.sy(Number(raw)).toFixed(1)}" r="2.4" fill="${C.made}" opacity="0.85"/>`;
      })
      .join(''),
    badge(bot.x - 34, bot.y + 37, 'C'),
  );

  return svg(W, rowsY(2) + 74 + 26, panels.join('\n'));
};

// --------------------------------------------------------- 6. memory profile

/**
 * Why streaming exists. Schematic, not measured: the in-memory engine holds every
 * row it has produced, the streaming engine holds one window and lets the rest go.
 */
FIGURES['streaming'] = () => {
  const b = box(PAD_L, TOP + 8, W - PAD_L - PAD_R, 170, [0, 100]);
  const growing = (u) => 6 + 90 * u;
  const flat = () => 14;
  const area = (f, color, op) => {
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const u = i / 120;
      pts.push(`${b.sx(u).toFixed(1)},${b.sy(f(u)).toFixed(1)}`);
    }
    return `<polygon points="${b.x},${b.y + b.h} ${pts.join(' ')} ${b.x + b.w},${b.y + b.h}" fill="${color}" opacity="${op}"/>`;
  };
  const curve = (f, color) => {
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const u = i / 120;
      pts.push(`${b.sx(u).toFixed(1)},${b.sy(f(u)).toFixed(1)}`);
    }
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2.4"/>`;
  };
  return svg(
    W,
    b.y + b.h + 40,
    [
      frame(b, { yTicks: [0, 50, 100], yLabels: false }),
      area(growing, C.drawn, 0.16),
      curve(growing, C.drawn),
      area(flat, C.made, 0.2),
      curve(flat, C.made),
      badge(b.sx(0.86), b.sy(84), 'A'),
      badge(b.sx(0.86), b.sy(26), 'B'),
      text(b.x, b.y + b.h + 20, '1', { anchor: 'start' }),
      text(b.x + b.w, b.y + b.h + 20, '1 000 000', { anchor: 'end' }),
    ].join('\n'),
  );
};

for (const [name, build] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), build());
}

console.log(`guides: ${Object.keys(FIGURES).length} language-free figures → ${OUT}`);
