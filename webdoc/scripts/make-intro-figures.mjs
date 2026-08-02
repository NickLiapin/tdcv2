/**
 * Figures for the introduction page — the two pictures that have to land before
 * a reader will spend any more time on the docs.
 *
 *   flat-vs-linked   the category difference: three independent draws that share
 *                    a line, against three draws where each one is conditioned
 *                    on the one before it.
 *   dependency-tree  what that buys: a value that can only come from the branch
 *                    the record already landed on, and an edge that therefore
 *                    cannot exist.
 *
 * Language-free by the rule in figure-kit.mjs. Colour carries the grouping,
 * letter badges carry the meaning, and the only glyphs inside the drawing are
 * numbers and the two universal sex signs.
 *
 * The counts in the tree are the real sizes of the English medical lists, so
 * the picture cannot drift away from the packs it describes.
 *
 * Run:  node webdoc/scripts/make-intro-figures.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARROW, C, badge, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'intro');

mkdirSync(OUT, { recursive: true });

/** Entries in a pack list — everything after the frontmatter block. */
function packCount(relPath) {
  const lines = readFileSync(join(ROOT, 'data', 'packs', relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return lines.slice(end + 1).filter((l) => l.trim() !== '').length;
}

const rect = (x, y, w, h, { fill = 'none', stroke = C.axis, r = 4, width = 1.4, dash = '' } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" ` +
  `stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

const line = (x1, y1, x2, y2, { stroke = C.axis, width = 1.4, dash = '', arrow = false } = {}) =>
  `<path d="M${x1},${y1} L${x2},${y2}" fill="none" stroke="${stroke}" stroke-width="${width}"` +
  `${dash ? ` stroke-dasharray="${dash}"` : ''}${arrow ? ' marker-end="url(#a)"' : ''}/>`;

/** A translucent fill of a palette colour, so the outline still reads. */
const tint = (hex, a = '28') => hex + a;

const FIGURES = {};

// --------------------------------------------------------- 1. flat vs linked

/**
 * Left: every column has its own source and is drawn on its own, so a record is
 * three unrelated values that happen to share a line. Right: one source starts
 * the record and each following value is drawn from what the previous one
 * selected, so the whole line belongs together.
 */
FIGURES['flat-vs-linked'] = () => {
  const W = 680;
  const H = 250;
  const HUES = [C.drawn, C.made, C.alt];

  // Fixed, not random: the figure must be identical on every rebuild.
  const MIXED = [
    [0, 2, 1],
    [2, 0, 0],
    [1, 1, 2],
    [0, 1, 0],
  ];
  const LINKED = [0, 2, 1, 0];

  const panel = (x0, sources, rows) => {
    const cw = 74;
    const gap = 12;
    const cols = [x0, x0 + cw + gap, x0 + 2 * (cw + gap)];
    const out = [];

    // The sources, and how each one reaches the record.
    for (const s of sources) out.push(...s(cols, cw));

    // Four records, one strip each.
    rows.forEach((hues, i) => {
      const y = 118 + i * 26;
      hues.forEach((h, c) => {
        out.push(rect(cols[c], y, cw, 18, { fill: tint(HUES[h]), stroke: HUES[h], r: 3 }));
      });
    });
    return out;
  };

  /**
   * A source holds values of every group — that is why it is drawn neutral with
   * one chip per group. Both panels draw from the same kind of source; what
   * differs is the wiring underneath it.
   */
  const pool = (x, cw) => {
    const out = [rect(x, 44, cw, 22, { stroke: C.faint, r: 3 })];
    HUES.forEach((h, i) => {
      out.push(rect(x + 8 + i * 20, 50, 14, 10, { fill: tint(h, '55'), stroke: h, r: 2, width: 1 }));
    });
    return out;
  };

  // Left panel: three separate sources, three straight drops, nothing across.
  const flatSources = (cols, cw) => {
    const out = [];
    cols.forEach((x) => {
      out.push(...pool(x, cw));
      out.push(line(x + cw / 2, 68, x + cw / 2, 110, { stroke: C.faint, arrow: true }));
    });
    return out;
  };

  // Right panel: one source opens the record, then each value feeds the next.
  const linkedSources = (cols, cw) => {
    const out = pool(cols[0], cw);
    out.push(line(cols[0] + cw / 2, 68, cols[0] + cw / 2, 110, { stroke: C.faint, arrow: true }));
    // The links live between the columns, one per record.
    for (let i = 0; i < 4; i++) {
      const y = 118 + i * 26 + 9;
      for (let c = 0; c < 2; c++) {
        out.push(line(cols[c] + cw + 1, y, cols[c + 1] - 2, y, { stroke: C.mark, arrow: true }));
      }
    }
    return out;
  };

  const body = [
    ARROW,
    ...panel(48, [flatSources], MIXED),
    ...panel(378, [linkedSources], LINKED.map((h) => [h, h, h])),

    badge(30, 55, 'A'),
    badge(30, 144, 'B'),
    badge(360, 55, 'C'),
    badge(360, 144, 'D'),

    // A hairline between the two halves, so they read as a comparison.
    line(340, 30, 340, 226, { stroke: C.faint, width: 1, dash: '3 5' }),
  ].join('\n');

  return svg(W, H, body);
};

// -------------------------------------------------------- 2. dependency tree

/**
 * The record picks a branch, and from there on only that branch's lists are
 * reachable. The dashed edge is the point of the drawing: it is the mistake the
 * flat generators make, and here it is not expressible.
 */
FIGURES['dependency-tree'] = () => {
  const W = 680;
  const H = 300;

  const general = packCount('en/medical/diagnosis.txt');
  const male = packCount('en/medical/diagnosisMale.txt');
  const female = packCount('en/medical/diagnosisFemale.txt');

  const FEM = C.alt;
  const MAS = C.drawn;
  const BOTH = C.made;

  // The record at the top.
  const root = { x: 290, y: 26, w: 100, h: 30 };
  // The branch it lands on.
  const fem = { x: 150, y: 108, w: 92, h: 40 };
  const mas = { x: 438, y: 108, w: 92, h: 40 };
  // What each branch can reach.
  const femDx = { x: 62, y: 206, w: 118, h: 46 };
  const bothDx = { x: 281, y: 206, w: 118, h: 46 };
  const masDx = { x: 500, y: 206, w: 118, h: 46 };

  const cx = (b) => b.x + b.w / 2;
  const bottom = (b) => b.y + b.h;

  const node = (b, colour, glyph, size) => [
    rect(b.x, b.y, b.w, b.h, { fill: tint(colour), stroke: colour, r: 6 }),
    text(cx(b), b.y + b.h / 2 + size * 0.36, glyph, {
      size,
      anchor: 'middle',
      fill: colour,
      weight: 700,
    }),
  ];

  /** Arrowheads have to carry the branch colour, or the tree stops reading. */
  const marker = (id, colour) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" ` +
    `orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colour}"/></marker>`;
  const MARKERS = `<defs>${marker('mf', FEM)}${marker('mm', MAS)}</defs>`;

  /** `dx` pulls the head off centre so two edges into one node stay apart. */
  const edge = (from, to, colour, dx = 0) =>
    `<path d="M${cx(from)},${bottom(from)} L${cx(to) + dx},${to.y - 3}" fill="none" ` +
    `stroke="${colour}" stroke-width="1.6" marker-end="url(#${colour === FEM ? 'mf' : 'mm'})"/>`;

  const body = [
    MARKERS,

    // A record, then the branch it takes.
    ...node(root, C.mark, '1', 15),
    edge(root, fem, FEM),
    edge(root, mas, MAS),
    ...node(fem, FEM, '♀', 22),
    ...node(mas, MAS, '♂', 22),

    // Each branch reaches its own list and the shared one.
    edge(fem, femDx, FEM),
    edge(fem, bothDx, FEM, -26),
    edge(mas, masDx, MAS),
    edge(mas, bothDx, MAS, 26),
    ...node(femDx, FEM, String(female), 19),
    ...node(bothDx, BOTH, String(general), 19),
    ...node(masDx, MAS, String(male), 19),

    // The edge that cannot exist. It is drawn only to be crossed out, so it
    // arcs clear of the two live edges instead of running straight through them.
    (() => {
      const x1 = fem.x + fem.w;
      const y1 = fem.y + fem.h * 0.55;
      const x2 = masDx.x + 24;
      const y2 = masDx.y - 4;
      const P = [
        [x1, y1],
        [(x1 + x2) / 2, y1 - 26],
        [x2, y2],
      ];
      const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const at = (t) => lerp(lerp(P[0], P[1], t), lerp(P[1], P[2], t), t);
      const d = (p0, p1, p2) =>
        `<path d="M${p0[0].toFixed(1)},${p0[1].toFixed(1)} Q${p1[0].toFixed(1)},${p1[1].toFixed(1)} ` +
        `${p2[0].toFixed(1)},${p2[1].toFixed(1)}" fill="none" stroke="${C.faint}" ` +
        `stroke-width="1.6" stroke-dasharray="6 5"/>`;

      // Split the arc and leave a gap, so the cross sits in clear space and the
      // figure needs no opaque halo — which would show as a blob on dark theme.
      const t1 = 0.4;
      const t2 = 0.6;
      const [mx, my] = at(0.5);
      const r = 8;
      return (
        d(P[0], lerp(P[0], P[1], t1), at(t1)) +
        d(at(t2), lerp(P[1], P[2], t2), P[2]) +
        `<path d="M${(mx - r).toFixed(1)},${(my - r).toFixed(1)} L${(mx + r).toFixed(1)},${(my + r).toFixed(1)} ` +
        `M${(mx + r).toFixed(1)},${(my - r).toFixed(1)} L${(mx - r).toFixed(1)},${(my + r).toFixed(1)}" ` +
        `stroke="${C.faint}" stroke-width="2.6" stroke-linecap="round" fill="none"/>`
      );
    })(),

    badge(root.x - 26, root.y + 15, 'A'),
    badge(fem.x - 26, fem.y + 20, 'B'),
    badge(femDx.x - 26, femDx.y + 23, 'C'),
    badge(bothDx.x + bothDx.w / 2, bothDx.y + bothDx.h + 24, 'D'),
    badge(fem.x + fem.w + 18, fem.y + fem.h * 0.55 - 20, 'E', { color: C.faint }),
  ].join('\n');

  return svg(W, H, body);
};

// ------------------------------------------------------------------- write

for (const [name, build] of Object.entries(FIGURES)) {
  const file = join(OUT, `${name}.svg`);
  writeFileSync(file, build());
  console.log(`wrote ${file}`);
}
