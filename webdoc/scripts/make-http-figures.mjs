/**
 * Figures for the http generator.
 *
 * Schematic, not data plots: the http generator has no curve or distribution to
 * show — its subject is the request/response protocol. So these are concept
 * diagrams (boxes and arrows), like concepts/output-layout.svg, and carry no
 * generated values that would need to match a CLI run.
 *
 * Language-free by the rule in figure-kit.mjs: every glyph is a latin letter or
 * a digit, and the badges are decoded by <Legend> in the page. The tokens a→A
 * echo the page's example service (which upper-cases its input).
 *
 * Every figure is 680 wide — <Figure> stretches an SVG to the column width, so a
 * narrower canvas would render oversized (a lesson from the mask figures).
 *
 * Run:  node webdoc/scripts/make-http-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C, badge, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'static', 'img', 'generators');
mkdirSync(OUT, { recursive: true });

const W = 680;
const CELL = 30;
const VGAP = 8;

/** Arrow heads coloured to match their line, in the palette's three roles. */
const HEADS =
  `<defs>` +
  [
    ['hd', C.drawn],
    ['hm', C.made],
    ['hk', C.mark],
    ['hf', C.faint],
  ]
    .map(
      ([id, colour]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colour}"/></marker>`,
    )
    .join('') +
  `</defs>`;

/** A vertical stack of boxed tokens; returns svg plus per-cell centre helpers. */
function column(x, yTop, tokens, colour) {
  const parts = tokens.map((tok, i) => {
    const y = yTop + i * (CELL + VGAP);
    return (
      `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="6" fill="${colour}" opacity="0.18" stroke="${colour}" stroke-width="1.4"/>` +
      text(x + CELL / 2, y + CELL / 2 + 5, tok, { anchor: 'middle', size: 14, weight: 700, fill: colour })
    );
  });
  return {
    svg: parts.join(''),
    cy: (i) => yTop + i * (CELL + VGAP) + CELL / 2,
    right: x + CELL,
    left: x,
  };
}

/** The service — an opaque box the engine only talks to. */
function serviceBox(cx, cy, w, h) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${C.mark}" opacity="0.1" stroke="${C.mark}" stroke-width="1.6"/>` +
    // three faint bars: "some code in here", no words
    [0.34, 0.5, 0.66]
      .map(
        (f) =>
          `<line x1="${x + 12}" y1="${(y + h * f).toFixed(1)}" x2="${x + w - 12}" y2="${(y + h * f).toFixed(1)}" stroke="${C.mark}" stroke-width="2" opacity="0.3"/>`,
      )
      .join('')
  );
}

function arrow(x1, y1, x2, y2, head, { width = 2, opacity = 0.9, dash = '' } = {}) {
  return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${headColour(head)}" stroke-width="${width}" opacity="${opacity}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#${head})"/>`;
}
const headColour = (h) => ({ hd: C.drawn, hm: C.made, hk: C.mark, hf: C.faint })[h];

const FIGURES = {};

// --------------------------------------------------------- 1. the flow
/**
 * The whole input column is sent as ONE request; the reply comes back one value
 * per row, in the same order. a→A stands in for a service that transforms each
 * value.
 */
FIGURES['http-flow'] = () => {
  const inTokens = ['a', 'b', 'c', 'd'];
  const outTokens = ['A', 'B', 'C', 'D'];
  const yTop = 40;
  const inX = 70;
  const outX = 580;
  const svcCx = W / 2;
  const stackH = inTokens.length * (CELL + VGAP) - VGAP;
  const svcCy = yTop + stackH / 2;

  const inp = column(inX, yTop, inTokens, C.drawn);
  const out = column(outX, yTop, outTokens, C.made);

  const parts = [
    HEADS,
    inp.svg,
    out.svg,
    serviceBox(svcCx, svcCy, 96, stackH + 6),
    // one batch in: a single arrow from the column to the service
    arrow(inp.right + 8, svcCy, svcCx - 52, svcCy, 'hd', { width: 3 }),
    // one batch out
    arrow(svcCx + 52, svcCy, out.left - 8, svcCy, 'hm', { width: 3 }),
    // faint per-row order connectors, input i ↔ reply i
    ...inTokens.map((_t, i) =>
      `<line x1="${inp.right}" y1="${inp.cy(i).toFixed(1)}" x2="${out.left}" y2="${out.cy(i).toFixed(1)}" stroke="${C.faint}" stroke-width="1" opacity="0.28" stroke-dasharray="2 3"/>`,
    ),
    badge(inX + CELL / 2, yTop - 18, 'A', { color: C.drawn }),
    badge(svcCx, svcCy - stackH / 2 - 20, 'B', { color: C.mark }),
    badge(outX + CELL / 2, yTop - 18, 'C', { color: C.made }),
  ];
  return svg(W, yTop + stackH + 30, parts.join('\n'));
};

// -------------------------------------------------------- 2. batch vs per-row
/**
 * Why a thousand rows is one request, not a thousand. Left: the tempting
 * per-row shape (one call each) — faint, because TDC does not do it. Right: the
 * batch — the whole column in a single call.
 */
FIGURES['http-batch'] = () => {
  const rows = 5;
  const yTop = 46;
  const stackH = rows * (CELL + VGAP) - VGAP;
  const toks = ['a', 'b', 'c', 'd', 'e'];

  const panel = (x0, head, batched) => {
    const col = column(x0, yTop, toks, batched ? C.made : C.faint);
    const svcCx = x0 + 210;
    const svcCy = yTop + stackH / 2;
    const arrows = batched
      ? [arrow(col.right + 8, svcCy, svcCx - 46, svcCy, head, { width: 3 })]
      : toks.map((_t, i) =>
          arrow(col.right + 8, col.cy(i), svcCx - 46, svcCy, head, {
            width: 1.4,
            opacity: 0.5,
            dash: '3 3',
          }),
        );
    return [
      col.svg,
      serviceBox(svcCx, svcCy, 80, stackH + 6),
      ...arrows,
    ].join('');
  };

  const parts = [
    HEADS,
    panel(40, 'hf', false),
    panel(390, 'hm', true),
    badge(40 + CELL / 2, yTop - 20, 'A', { color: C.faint }),
    badge(390 + CELL / 2, yTop - 20, 'B', { color: C.made }),
  ];
  return svg(W, yTop + stackH + 28, parts.join('\n'));
};

let n = 0;
for (const [name, make] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), make());
  n += 1;
}
console.log(`http: ${n} language-free figures → ${OUT}`);
