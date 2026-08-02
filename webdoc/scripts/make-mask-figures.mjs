/**
 * Figures for positional indices in a mask.
 *
 * Language-free by the rule in figure-kit.mjs: every glyph on these pictures is
 * a latin letter, a digit, or a punctuation mark that the mask itself contains.
 * Nothing here needs translating — the same three files serve every locale, and
 * the meaning of the badges is decoded by <Legend> in the page text.
 *
 * Every output row is produced by the real CLI, not typed in.
 *
 * Run:  node webdoc/scripts/make-mask-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C, badge, makeRunner, svg, text } from './figure-kit.mjs';

/**
 * Arrow heads in the SAME colour as their line. The shared ARROW marker in
 * figure-kit is a single blue head, which reads as a third meaning when the
 * lines themselves carry colour.
 */
const HEADS =
  `<defs>` +
  [
    ['hd', C.drawn],
    ['hm', C.made],
  ]
    .map(
      ([id, colour]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${colour}"/></marker>`,
    )
    .join('') +
  `</defs>`;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'guides');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'mask');

mkdirSync(OUT, { recursive: true });

/** One value through one mask, straight from the engine. */
function masked(value, pattern) {
  const rows = run(
    `<tdc><env count="1" seed="doc">` +
      `<sequence name="V"><gen type="text" value="${value}" mask="${pattern}"/></sequence>` +
      `</env><block><line><data>\${{V}}</data></line></block></tdc>`,
  );
  return rows[0] ?? '';
}

// Every figure on the site is drawn on a 680-wide canvas, because <Figure>
// stretches an SVG to the column width: a narrower canvas is scaled UP, and the
// same 34px cell then renders twice the size of everything else on the page.
const W = 680;
const CELL = 34;
const GAP = 5;

/** Left origin that centres a row of `n` cells on the shared canvas. */
const rowX = (n) => Math.round((W - (n * (CELL + GAP) - GAP)) / 2);

/** A row of boxed characters. `colourOf(i)` decides each cell's colour. */
function cells(chars, x0, y, colourOf, { index = false } = {}) {
  const parts = [];
  chars.forEach((ch, i) => {
    const x = x0 + i * (CELL + GAP);
    const colour = colourOf(i);
    parts.push(
      `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="6" fill="${colour}" opacity="${colour === C.faint ? 0.16 : 0.2}" stroke="${colour}" stroke-width="1.4"/>`,
      text(x + CELL / 2, y + CELL / 2 + 5, ch, {
        anchor: 'middle',
        size: 15,
        weight: 700,
        fill: colour === C.faint ? C.axis : colour,
      }),
    );
    if (index) {
      parts.push(
        text(x + CELL / 2, y + CELL + 14, String(i), { anchor: 'middle', size: 11, fill: C.axis }),
      );
    }
  });
  return parts.join('');
}

const cx = (x0, i) => x0 + i * (CELL + GAP) + CELL / 2;

/** A curved arrow from one cell's bottom to another cell's top. */
function hop(x1, y1, x2, y2, colour = C.made) {
  const dy = Math.max(26, Math.abs(x2 - x1) * 0.28);
  const head = colour === C.drawn ? 'hd' : 'hm';
  return (
    `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} C${x1.toFixed(1)},${(y1 + dy).toFixed(1)} ` +
    `${x2.toFixed(1)},${(y2 - dy).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" ` +
    `fill="none" stroke="${colour}" stroke-width="1.6" opacity="0.85" marker-end="url(#${head})"/>`
  );
}

const FIGURES = {};

// ------------------------------------------------------------- 1. moving
/**
 * `x[4]-xxxx` on ABCDE. One index pulls the last character to the front; the
 * bare slots then take what is left, in their original order.
 */
FIGURES['mask-move'] = () => {
  const input = 'ABCDE';
  const pattern = 'x[4]-xxxx';
  const out = masked(input, pattern);
  const inChars = Array.from(input);
  const outChars = Array.from(out);

  const xIn = rowX(inChars.length);
  const xOut = rowX(outChars.length);
  const yIn = 34;
  const yOut = 150;
  const indexed = new Set([4]); // what x[4] took
  const literal = new Set([1]); // the "-" in the output row

  const body = [
    HEADS,
    cells(inChars, xIn, yIn, (i) => (indexed.has(i) ? C.drawn : C.made), { index: true }),
    cells(outChars, xOut, yOut, (i) => (literal.has(i) ? C.faint : i === 0 ? C.drawn : C.made)),
    // the indexed jump
    hop(cx(xIn, 4), yIn + CELL + 20, cx(xOut, 0), yOut - 6, C.drawn),
    // the four that flowed on in order
    ...[0, 1, 2, 3].map((i) => hop(cx(xIn, i), yIn + CELL + 20, cx(xOut, i + 2), yOut - 6, C.made)),
    badge(xIn - 26, yIn + CELL / 2, 'A'),
    badge(xOut - 26, yOut + CELL / 2, 'B'),
  ].join('\n');

  return svg(W, yOut + CELL + 24, body);
};

// ---------------------------------------------------------- 2. the pool
/**
 * The same run in two stages: what the index removed, and what the bare slots
 * had left. Emission and consumption are different channels, and this is the
 * only picture that shows the second one.
 */
FIGURES['mask-pool'] = () => {
  const inChars = Array.from('ABCDE');
  const x0 = rowX(inChars.length);
  const yTop = 30;
  const yBot = 108;

  const body = [
    HEADS,
    cells(inChars, x0, yTop, (i) => (i === 4 ? C.drawn : C.made), { index: true }),
    // after x[4]: position 4 has left the pool
    cells(inChars, x0, yBot, (i) => (i === 4 ? C.faint : C.made), { index: true }),
    `<line x1="${cx(x0, 4) - 13}" y1="${yBot + 6}" x2="${cx(x0, 4) + 13}" y2="${yBot + CELL - 6}" stroke="${C.axis}" stroke-width="1.6" opacity="0.7"/>`,
    `<line x1="${cx(x0, 4) + 13}" y1="${yBot + 6}" x2="${cx(x0, 4) - 13}" y2="${yBot + CELL - 6}" stroke="${C.axis}" stroke-width="1.6" opacity="0.7"/>`,
    badge(x0 - 26, yTop + CELL / 2, 'A'),
    badge(x0 - 26, yBot + CELL / 2, 'B'),
  ].join('\n');

  return svg(W, yBot + CELL + 34, body);
};

// ------------------------------------------------------------ 3. copying
/**
 * `x[0..1]-*-x[0..1]` on AB1234 — the warehouse code whose head is echoed at
 * the tail. Two arrows leave the SAME two cells, which is the whole difference
 * between a move and a copy.
 */
FIGURES['mask-copy'] = () => {
  const input = 'AB1234';
  const pattern = 'x[0..1]-*-x[0..1]';
  const out = masked(input, pattern);
  const inChars = Array.from(input);
  const outChars = Array.from(out);

  const xIn = rowX(inChars.length);
  const xOut = rowX(outChars.length);
  const yIn = 34;
  const yOut = 150;
  // out = A B - 1 2 3 4 - A B
  const head = new Set([0, 1, 8, 9]);
  const dash = new Set([2, 7]);

  const body = [
    HEADS,
    cells(inChars, xIn, yIn, (i) => (i < 2 ? C.drawn : C.made), { index: true }),
    cells(outChars, xOut, yOut, (i) => (dash.has(i) ? C.faint : head.has(i) ? C.drawn : C.made)),
    // TWO arrows out of each named cell — that is the whole point of the picture.
    // out = A B - 1 2 3 4 - A B, so position 0 lands at 0 and 8, position 1 at 1 and 9.
    hop(cx(xIn, 0), yIn + CELL + 20, cx(xOut, 0), yOut - 6, C.drawn),
    hop(cx(xIn, 0), yIn + CELL + 20, cx(xOut, 8), yOut - 6, C.drawn),
    hop(cx(xIn, 1), yIn + CELL + 20, cx(xOut, 1), yOut - 6, C.drawn),
    hop(cx(xIn, 1), yIn + CELL + 20, cx(xOut, 9), yOut - 6, C.drawn),
    ...[2, 3, 4, 5].map((i) => hop(cx(xIn, i), yIn + CELL + 20, cx(xOut, i + 1), yOut - 6, C.made)),
    badge(xIn - 26, yIn + CELL / 2, 'A'),
    badge(xOut - 26, yOut + CELL / 2, 'B'),
  ].join('\n');

  return svg(W, yOut + CELL + 24, body);
};

let n = 0;
for (const [name, make] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), make());
  n += 1;
}
console.log(`mask: ${n} language-free figures → ${OUT}`);
