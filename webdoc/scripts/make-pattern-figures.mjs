/**
 * Figures for the `pattern` generator page.
 *
 * Two kinds of asset:
 *
 *   1. INPUT files — real drawings a user could hand to `src=`. Strokes on a
 *      transparent background and nothing else, because anything opaque in the
 *      file is read as part of the drawing.
 *   2. FIGURES — the same drawings with axes and annotations, overlaid with
 *      values actually generated from those files by running the engine. So a
 *      picture here is never an impression of the behaviour; it is the behaviour.
 *
 * No figure contains a word: see the translation rule in figure-kit.mjs. Numbers
 * and attribute spellings stay inside; everything else is a letter badge that the
 * page text decodes through <Legend>.
 *
 * Run:  node webdoc/scripts/make-pattern-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARROW,
  C,
  areaPath,
  badge,
  bandPath,
  box,
  curvePath,
  dots,
  encodePng,
  frame,
  histogram,
  makeRunner,
  oneColumn,
  rowTicks,
  svg,
  text,
} from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'pattern');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'pattern');

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------- input files

const PW = 240; // deliberately small: only the shape matters, never the size
const PH = 140;
const INK = [24, 24, 27];

/**
 * Paint a picture from layers given in VALUE space (u ∈ [0,1] across, v ∈ [0,100]
 * up). A `stroke` layer sets one pixel per column, which is what makes a line
 * read as an exact value rather than a band; a `fill` layer paints every pixel
 * between two curves, which is what makes a solid shape read as a corridor.
 */
function paint(layers, { background } = {}) {
  const rgba = new Uint8Array(PW * PH * 4);
  if (background) {
    for (let i = 0; i < PW * PH; i++) rgba.set([...background, 255], i * 4);
  }
  const row = (v) => Math.round((PH - 1) * (1 - v / 100));
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= PW || y >= PH) return;
    rgba.set([...rgb, 255], (y * PW + x) * 4);
  };
  for (const layer of layers) {
    const rgb = layer.rgb ?? INK;
    for (let x = 0; x < PW; x++) {
      const u = x / (PW - 1);
      if (layer.fill) {
        const a = row(layer.fill[0](u));
        const b = row(layer.fill[1](u));
        for (let y = Math.min(a, b); y <= Math.max(a, b); y++) put(x, y, rgb);
      } else {
        put(x, row(layer.stroke(u)), rgb);
      }
    }
  }
  return rgba;
}

const TAU = Math.PI * 2;
const line = (u) => 50 + 32 * Math.sin(TAU * u);
const tunnelUpper = (u) => 62 + 22 * Math.sin(TAU * u);
const tunnelLower = (u) => 26 + 14 * Math.sin(TAU * u + 1);
const splitUp = (u) => (u < 0.5 ? 50 : 50 + 70 * (u - 0.5));
const splitDown = (u) => (u < 0.5 ? 50 : 50 - 60 * (u - 0.5));
const bell = (u, centre, width, height) => height * Math.exp(-(((u - centre) / width) ** 2) / 2);
const hump = (u) => bell(u, 0.5, 0.13, 96);
const twoHumps = (u) => Math.max(bell(u, 0.3, 0.07, 45), bell(u, 0.68, 0.07, 90));

// A car silhouette: proof that "draw anything closed" is not a figure of speech.
const carTop = (u) => {
  if (u < 0.06 || u > 0.94) return 12;
  if (u < 0.22) return 42;
  if (u < 0.3) return 42 + ((u - 0.22) / 0.08) * 30;
  if (u < 0.58) return 72;
  if (u < 0.66) return 72 - ((u - 0.58) / 0.08) * 30;
  return 42;
};
const carBottom = (u) =>
  (Math.abs(u - 0.25) < 0.08 || Math.abs(u - 0.72) < 0.08) && u > 0.06 && u < 0.94 ? 2 : 12;

const GREY = [176, 176, 180];
const darkStroke = (u) => 68 + 10 * Math.sin(TAU * u);
const greyStroke = (u) => 28 + 8 * Math.sin(TAU * u + 2);

const PNGS = {
  'line-input.png': paint([{ stroke: line }]),
  'tunnel-input.png': paint([{ stroke: tunnelUpper }, { stroke: tunnelLower }]),
  'split-input.png': paint([{ stroke: splitUp }, { stroke: splitDown }]),
  'hump-input.png': paint([{ fill: [hump, () => 0] }]),
  'humps2-input.png': paint([{ fill: [twoHumps, () => 0] }]),
  'car-input.png': paint([{ fill: [carTop, carBottom] }]),
  // An opaque canvas, so ink is decided by darkness and `ink_threshold` matters.
  'threshold-input.png': paint([{ stroke: darkStroke }, { stroke: greyStroke, rgb: GREY }], {
    background: [255, 255, 255],
  }),
};
for (const [name, rgba] of Object.entries(PNGS)) {
  writeFileSync(join(OUT, name), encodePng(PW, PH, rgba));
}

const BEZIER = [
  [0, 20],
  [60, 130],
  [180, -10],
  [240, 110],
];
writeFileSync(
  join(OUT, 'curve-input.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 140" width="240" height="140">
  <g transform="translate(0,140) scale(1,-1)">
    <path d="M${BEZIER[0][0]} ${BEZIER[0][1]} C ${BEZIER[1][0]} ${BEZIER[1][1]}, ${BEZIER[2][0]} ${BEZIER[2][1]}, ${BEZIER[3][0]} ${BEZIER[3][1]}"
          fill="none" stroke="#18181b" stroke-width="2"/>
  </g>
</svg>
`,
);

// ------------------------------------------------- run the engine for real

const src = (f) => `src="${join(OUT, f)}"`;
const gen = (attrs) => `<gen type="pattern" ${attrs}/>`;
const values = (attrs, count, seed) => run(oneColumn(gen(attrs), count, seed)).map(Number);

/**
 * What `points=` actually produces: straight segments through the points, with
 * the list's own y extent normalized into y_range. (A PNG differs — there the
 * image frame is the scale, which is why those figures plot the raw curve.)
 */
function pointsValue(pts, [lo, hi] = [0, 100]) {
  const ys = pts.map(([, y]) => y);
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  const last = pts[pts.length - 1][0];
  return (u) => {
    const x = u * last;
    let v = ys[ys.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [xa, ya] = pts[i];
      const [xb, yb] = pts[i + 1];
      if (x <= xb) {
        v = ya + ((yb - ya) * (x - xa)) / (xb - xa);
        break;
      }
    }
    return yHi === yLo ? lo : lo + ((v - yLo) / (yHi - yLo)) * (hi - lo);
  };
}

const asPoints = (pts) => `points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}"`;

const ZIGZAG_PTS = [
  [0, 12],
  [25, 88],
  [50, 20],
  [75, 84],
  [100, 16],
];
const TRIANGLE_PTS = [
  [0, 0],
  [50, 100],
  [100, 0],
];
const SAW_PTS = Array.from({ length: 41 }, (_, i) => [i, i % 2 === 0 ? 0 : 100]);

/** The Bezier of curve-input.svg, read the way the engine reads it. */
const bezierCurve = (() => {
  const at = (t) => {
    const m = 1 - t;
    const c = (i) =>
      m ** 3 * BEZIER[0][i] +
      3 * m * m * t * BEZIER[1][i] +
      3 * m * t * t * BEZIER[2][i] +
      t ** 3 * BEZIER[3][i];
    return [c(0), 140 - c(1)]; // the <g> transform: translate(0,140) scale(1,-1)
  };
  const samples = Array.from({ length: 401 }, (_, i) => at(i / 400));
  const heights = samples.map(([, y]) => -y); // SVG y grows down; the reader flips it
  const lo = Math.min(...heights);
  const hi = Math.max(...heights);
  const xLo = samples[0][0];
  const xHi = samples[samples.length - 1][0];
  return (u) => {
    const x = xLo + u * (xHi - xLo);
    let k = 0;
    while (k < samples.length - 2 && samples[k + 1][0] < x) k++;
    const [xa, ya] = samples[k];
    const [xb, yb] = samples[k + 1];
    const s = xb === xa ? 0 : (x - xa) / (xb - xa);
    return ((-(ya + (yb - ya) * s) - lo) / (hi - lo)) * 100;
  };
})();

const DATA = {
  signal: values(`${src('line-input.png')} y_range="0..100"`, 40),
  tunnel: values(`${src('tunnel-input.png')} y_range="0..100"`, 300),
  split: values(`${src('split-input.png')} y_range="0..100"`, 60),
  car: values(`${src('car-input.png')} y_range="0..100"`, 300),
  spread: values(`${src('line-input.png')} y_range="0..100" spread="6"`, 60),
  density: values(`${src('hump-input.png')} y_range="0..100" mode="density"`, 6000),
  density2: values(`${src('humps2-input.png')} y_range="0..100" mode="density"`, 6000),
  svg: values(`${src('curve-input.svg')} y_range="0..100"`, 40),
  thrLow: values(`${src('threshold-input.png')} y_range="0..100" ink_threshold="0.5"`, 60),
  thrHigh: values(`${src('threshold-input.png')} y_range="0..100" ink_threshold="0.8"`, 60),
  sawMany: values(`${asPoints(SAW_PTS)} y_range="0..100"`, 300),
  sawFew: values(`${asPoints(SAW_PTS)} y_range="0..100" decimals="1"`, 6),
  interp: Object.fromEntries(
    ['linear', 'smooth', 'step'].map((m) => [
      m,
      values(`${asPoints(ZIGZAG_PTS)} y_range="0..100" interp="${m}"`, 41),
    ]),
  ),
  yrange: {
    a: values(`${asPoints(TRIANGLE_PTS)} y_range="0..100"`, 25),
    b: values(`${asPoints(TRIANGLE_PTS)} y_range="0..40"`, 25),
    c: values(`${asPoints(TRIANGLE_PTS)} y_range="-2..2" decimals="2"`, 25),
  },
};

// ------------------------------------------------------------------ figures

const W = 680; // one column of the docs, at the width it is actually rendered
const PAD_L = 46;
const PAD_R = 34;
const TOP = 18; // no title row: the heading is page text, not part of the drawing

const wide = (h = 176) => box(PAD_L, TOP, W - PAD_L - PAD_R, h);

const FIGURES = {};

FIGURES['signal'] = () => {
  const b = wide();
  return svg(
    W,
    b.y + b.h + 32,
    [
      frame(b, { yTicks: [0, 25, 50, 75, 100], xTicks: rowTicks(DATA.signal.length) }),
      curvePath(b, line),
      dots(b, DATA.signal),
    ].join('\n'),
  );
};

FIGURES['measure'] = () => {
  const left = box(PAD_L + 12, TOP + 14, 262, 140);
  const right = box(PAD_L + 332, TOP + 14, 262, 140);
  const single = (u) => 55 + 18 * Math.sin(TAU * u);
  const bandTop = (u) => 78 + 10 * Math.sin(TAU * u);
  const bandBottom = (u) => 28 + 10 * Math.sin(TAU * u + 1);

  const panel = (b, curves, isBand, letter) => {
    const top = curves[0](0.5);
    const bottom = curves[curves.length - 1](0.5);
    const x = b.sx(0.5).toFixed(1);
    const parts = [
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="${C.axis}" stroke-width="1" opacity="0.35"/>`,
      ...(isBand ? [bandPath(b, curves[0], curves[1])] : []),
      ...curves.map((f) => curvePath(b, f)),
      `<line x1="${x}" y1="${b.y + 4}" x2="${x}" y2="${(b.sy(top) - 8).toFixed(1)}" stroke="${C.mark}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#a)"/>`,
      `<line x1="${x}" y1="${b.y + b.h - 4}" x2="${x}" y2="${(b.sy(bottom) + 8).toFixed(1)}" stroke="${C.mark}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#a)"/>`,
    ];
    if (isBand) {
      parts.push(
        `<line x1="${x}" y1="${b.sy(top).toFixed(1)}" x2="${x}" y2="${b.sy(bottom).toFixed(1)}" stroke="${C.mark}" stroke-width="7" opacity="0.32" stroke-linecap="round"/>`,
        `<circle cx="${x}" cy="${b.sy(top).toFixed(1)}" r="3.6" fill="${C.mark}"/>`,
        `<circle cx="${x}" cy="${b.sy(bottom).toFixed(1)}" r="3.6" fill="${C.mark}"/>`,
      );
    } else {
      parts.push(`<circle cx="${x}" cy="${b.sy(top).toFixed(1)}" r="4.8" fill="${C.mark}"/>`);
    }
    parts.push(badge(b.x + 15, b.y + 15, letter));
    return parts.join('\n');
  };

  return svg(
    W,
    198,
    [ARROW, panel(left, [single], false, 'A'), panel(right, [bandTop, bandBottom], true, 'B')].join(
      '\n',
    ),
  );
};

FIGURES['tunnel'] = () => {
  const b = wide();
  const u = 0.62; // a column where the band runs low, leaving the top half free
  const x = b.sx(u).toFixed(1);
  return svg(
    W,
    b.y + b.h + 32,
    [
      ARROW,
      frame(b, { yTicks: [0, 25, 50, 75, 100], xTicks: rowTicks(DATA.tunnel.length) }),
      bandPath(b, tunnelUpper, tunnelLower),
      curvePath(b, tunnelUpper),
      curvePath(b, tunnelLower),
      dots(b, DATA.tunnel, { r: 1.9, opacity: 0.7 }),
      `<line x1="${x}" y1="${b.sy(tunnelUpper(u)).toFixed(1)}" x2="${x}" y2="${b.sy(tunnelLower(u)).toFixed(1)}" stroke="${C.mark}" stroke-width="8" opacity="0.4" stroke-linecap="round"/>`,
      `<circle cx="${x}" cy="${b.sy(tunnelUpper(u)).toFixed(1)}" r="3.4" fill="${C.mark}"/>`,
      `<circle cx="${x}" cy="${b.sy(tunnelLower(u)).toFixed(1)}" r="3.4" fill="${C.mark}"/>`,
      `<line x1="${x}" y1="${b.sy(90).toFixed(1)}" x2="${x}" y2="${(b.sy(tunnelUpper(u)) - 8).toFixed(1)}" stroke="${C.mark}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#a)"/>`,
      badge(b.sx(u), b.sy(97), 'A'),
    ].join('\n'),
  );
};

FIGURES['split'] = () => {
  const b = wide();
  return svg(
    W,
    b.y + b.h + 32,
    [
      ARROW,
      frame(b, { yTicks: [0, 25, 50, 75, 100], xTicks: rowTicks(DATA.split.length) }),
      bandPath(b, splitUp, splitDown),
      curvePath(b, splitUp),
      curvePath(b, splitDown),
      dots(b, DATA.split, { r: 2.6 }),
      `<line x1="${b.sx(0.5).toFixed(1)}" y1="${b.sy(86).toFixed(1)}" x2="${b.sx(0.5).toFixed(1)}" y2="${b.sy(58).toFixed(1)}" stroke="${C.mark}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#a)"/>`,
      badge(b.sx(0.5), b.sy(95), 'A'),
      badge(b.sx(0.22), b.sy(22), 'B'),
      badge(b.sx(0.84), b.sy(90), 'C'),
    ].join('\n'),
  );
};

FIGURES['car'] = () => {
  const b = wide();
  return svg(
    W,
    b.y + b.h + 32,
    [
      ARROW,
      frame(b, { yTicks: [0, 25, 50, 75, 100], xTicks: rowTicks(DATA.car.length) }),
      bandPath(b, carTop, carBottom, { opacity: 0.22 }),
      curvePath(b, carTop, { width: 1.8 }),
      curvePath(b, carBottom, { width: 1.8 }),
      dots(b, DATA.car, { r: 1.9, opacity: 0.7 }),
      `<line x1="${b.sx(0.25).toFixed(1)}" y1="${b.sy(86).toFixed(1)}" x2="${b.sx(0.25).toFixed(1)}" y2="${b.sy(10).toFixed(1)}" stroke="${C.mark}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#a)"/>`,
      badge(b.sx(0.25), b.sy(95), 'A'),
      badge(b.sx(0.03), b.sy(30), 'B'),
    ].join('\n'),
  );
};

FIGURES['saw'] = () => {
  const drawn = pointsValue(SAW_PTS);
  const panels = [
    { data: DATA.sawMany, r: 1.6, letter: 'A' },
    { data: DATA.sawFew, r: 4, letter: 'B' },
  ].map((p, i) => {
    const b = box(PAD_L + i * 320, TOP + 10, 262, 150);
    return [
      frame(b, { yTicks: [0, 50, 100], yLabels: i === 0 }),
      curvePath(b, drawn, { width: 1 }),
      dots(b, p.data, { r: p.r }),
      badge(b.x + b.w - 15, b.y + 15, p.letter),
    ].join('\n');
  });
  return svg(W, 200, panels.join('\n'));
};

FIGURES['yrange'] = () => {
  const specs = [
    { key: 'a', dom: [0, 100], ticks: [0, 50, 100], label: 'y_range="0..100"' },
    { key: 'b', dom: [0, 40], ticks: [0, 20, 40], label: 'y_range="0..40"' },
    { key: 'c', dom: [-2, 2], ticks: [-2, 0, 2], label: 'y_range="-2..2"' },
  ];
  const panels = specs.map((s, i) => {
    const b = box(PAD_L + i * 208, TOP + 6, 152, 150, s.dom);
    return [
      frame(b, { yTicks: s.ticks }),
      curvePath(b, pointsValue(TRIANGLE_PTS, s.dom), { width: 1.8 }),
      dots(b, DATA.yrange[s.key], { r: 2.6 }),
      // An attribute spelling is code, not language: it belongs inside the picture.
      text(b.x + b.w / 2, b.y + b.h + 28, s.label, { size: 11.5, anchor: 'middle' }),
    ].join('\n');
  });
  return svg(W, 216, panels.join('\n'));
};

FIGURES['interp'] = () => {
  const drawn = pointsValue(ZIGZAG_PTS);
  const panels = ['linear', 'smooth', 'step'].map((m, i) => {
    const b = box(PAD_L + i * 208, TOP + 6, 152, 152);
    return [
      frame(b, { yTicks: [0, 50, 100], yLabels: i === 0 }),
      curvePath(b, drawn, { width: 1.6, dash: '5 4' }),
      dots(b, DATA.interp[m], { r: 2.3 }),
      text(b.x + b.w / 2, b.y + b.h + 28, `interp="${m}"`, { size: 12, anchor: 'middle' }),
    ].join('\n');
  });
  return svg(W, 218, panels.join('\n'));
};

FIGURES['spread'] = () => {
  const b = wide(166);
  return svg(
    W,
    b.y + b.h + 32,
    [
      frame(b, { yTicks: [0, 25, 50, 75, 100], xTicks: rowTicks(DATA.spread.length) }),
      bandPath(
        b,
        (u) => line(u) + 6,
        (u) => line(u) - 6,
      ),
      curvePath(b, line, { dash: '6 4' }),
      dots(b, DATA.spread, { r: 2.6 }),
    ].join('\n'),
  );
};

FIGURES['svg'] = () => {
  const b = wide();
  return svg(
    W,
    b.y + b.h + 32,
    [
      frame(b, { yTicks: [0, 25, 50, 75, 100], xTicks: rowTicks(DATA.svg.length) }),
      curvePath(b, bezierCurve),
      dots(b, DATA.svg),
    ].join('\n'),
  );
};

FIGURES['threshold'] = () => {
  const panels = [
    { data: DATA.thrLow, band: false, label: 'ink_threshold="0.5"' },
    { data: DATA.thrHigh, band: true, label: 'ink_threshold="0.8"' },
  ].map((p, i) => {
    const b = box(PAD_L + i * 320, TOP + 6, 262, 150);
    return [
      frame(b, { yTicks: [0, 50, 100], yLabels: i === 0 }),
      ...(p.band ? [bandPath(b, darkStroke, greyStroke)] : []),
      curvePath(b, greyStroke, { color: C.faint, width: 1.8 }),
      curvePath(b, darkStroke, { width: 1.8 }),
      dots(b, p.data, { r: 2.4 }),
      text(b.x + b.w / 2, b.y + b.h + 28, p.label, { size: 11.5, anchor: 'middle' }),
    ].join('\n');
  });
  return svg(W, 212, panels.join('\n'));
};

/** Drawn shape on top, the histogram it produced below, on one value axis. */
function densityFigure(shape, vals, marks) {
  const top = box(PAD_L, TOP, W - PAD_L - PAD_R, 112);
  const bot = box(PAD_L, TOP + 148, W - PAD_L - PAD_R, 112);
  return svg(
    W,
    TOP + 148 + 112 + 34,
    [
      ARROW,
      areaPath(top, shape),
      curvePath(top, shape),
      `<line x1="${top.x}" y1="${top.y + top.h}" x2="${top.x + top.w}" y2="${top.y + top.h}" stroke="${C.axis}" stroke-width="1" opacity="0.55"/>`,
      marks(top),
      histogram(bot, vals),
      `<line x1="${bot.x}" y1="${bot.y + bot.h}" x2="${bot.x + bot.w}" y2="${bot.y + bot.h}" stroke="${C.axis}" stroke-width="1" opacity="0.55"/>`,
      [0, 0.25, 0.5, 0.75, 1]
        .map(
          (u) =>
            `<line x1="${bot.sx(u).toFixed(1)}" y1="${bot.y + bot.h}" x2="${bot.sx(u).toFixed(1)}" y2="${bot.y + bot.h + 4}" stroke="${C.axis}" opacity="0.55"/>` +
            text(bot.sx(u), bot.y + bot.h + 17, String(Math.round(u * 100)), { anchor: 'middle' }),
        )
        .join(''),
      badge(top.x + top.w - 15, top.y + 15, 'A'),
      badge(bot.x + bot.w - 15, bot.y + 15, 'B'),
    ].join('\n'),
  );
}

FIGURES['density'] = () =>
  densityFigure(hump, DATA.density, (top) => {
    const u = 0.36;
    const x = top.sx(u);
    return (
      `<line x1="${x.toFixed(1)}" y1="${top.sy(0).toFixed(1)}" x2="${x.toFixed(1)}" y2="${top.sy(hump(u)).toFixed(1)}" stroke="${C.mark}" stroke-width="1.6" marker-start="url(#a)" marker-end="url(#a)"/>` +
      badge(x + 18, top.sy(20), 'C')
    );
  });

FIGURES['density2'] = () =>
  densityFigure(
    twoHumps,
    DATA.density2,
    (top) => badge(top.sx(0.3), top.sy(60), 'C') + badge(top.sx(0.68), top.sy(106), 'D'),
  );

// --------------------------------------------------------------------- write

for (const [name, build] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), build());
}

console.log(
  `pattern: ${Object.keys(PNGS).length} PNG + 1 SVG input + ` +
    `${Object.keys(FIGURES).length} language-free figures → ${OUT}`,
);
