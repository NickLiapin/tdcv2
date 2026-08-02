/**
 * Figures for the compute pages.
 *
 * Five drawings, each about something prose keeps failing to convey: what moves
 * where inside a loop, where the string world ends and the number world begins,
 * and which branch of a fork the value actually took. A table can list the steps;
 * only a picture shows that the jar carried between them is the same jar.
 *
 * The numbers are not invented. `4816 → 19` is what the engine prints for the
 * config on the lists page, run before this file was written.
 *
 * Words: none, per the translation rule in figure-kit.mjs. Every label a reader
 * needs is a latin badge explained by a <Legend> in the page text.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARROW, C, badge, svg, text } from './figure-kit.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'img', 'compute');

/** A rounded box with a centered glyph. */
function cell(x, y, w, h, label, { fill = 'none', stroke = C.axis, dash = null, size = 13 } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${fill}" ` +
    `stroke="${stroke}" stroke-width="1.5"${d}/>` +
    text(x + w / 2, y + h / 2 + size / 3, label, { anchor: 'middle', size, weight: 600, fill: stroke })
  );
}

// The kit ships one arrowhead, in the annotation colour. A figure that draws
// arrows in another colour needs a head to match, or the line and its tip
// disagree — so these two are defined here and picked by colour.
const HEADS = { [C.faint]: 'af', [C.made]: 'am' };
const EXTRA_HEADS =
  '<defs>' +
  Object.entries(HEADS)
    .map(
      ([color, id]) =>
        `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" ` +
        `markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`,
    )
    .join('') +
  '</defs>';

function arrow(x1, y1, x2, y2, { color = C.mark, dash = null } = {}) {
  const d = dash ? ` stroke-dasharray="${dash}"` : '';
  const head = HEADS[color] ?? 'a';
  return (
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ` +
    `stroke-width="1.6" marker-end="url(#${head})"${d}/>`
  );
}

// ---------------------------------------------------------------- reduce
// Four steps of summing the digits of 4816. The jar is drawn once per step so
// the reader can see the same container being handed along, not four numbers.
function reduceFigure() {
  const W = 760;
  const H = 250;
  const digits = [4, 8, 1, 6];
  const jars = [0, 4, 12, 13, 19]; // init, then after each step
  const x0 = 70;
  const step = 160;
  const parts = [ARROW];

  // the shelf: the string, split into the characters the loop walks
  parts.push(badge(24, 44, 'A', { color: C.drawn }));
  digits.forEach((d, i) => {
    parts.push(cell(x0 + i * step, 28, 44, 34, String(d), { stroke: C.drawn }));
  });

  // the jar before the first step comes from <init>
  parts.push(badge(x0 - 34, 92, 'B', { color: C.mark }));
  parts.push(cell(x0 - 56, 114, 44, 36, String(jars[0]), { stroke: C.mark, dash: '4 3' }));

  // one jar per step, each fed by the previous jar and the digit above it
  parts.push(badge(24, 132, 'C', { color: C.made }));
  jars.slice(1).forEach((v, i) => {
    const jx = x0 + i * step;
    parts.push(cell(jx, 114, 44, 36, String(v), { stroke: C.made }));
    // digit falls into this step
    parts.push(arrow(jx + 22, 66, jx + 22, 110));
    // the jar is handed from the previous step
    const fromX = i === 0 ? x0 - 12 : jx - step + 44;
    parts.push(arrow(fromX, 132, jx - 4, 132));
  });

  // the answer leaves the last jar
  parts.push(badge(W - 26, 132, 'D', { color: C.made }));
  parts.push(arrow(x0 + 3 * step + 44, 132, W - 40, 132));

  // step numbers, universal digits, no words
  digits.forEach((_, i) => {
    parts.push(
      text(x0 + i * step + 22, 196, String(i), { anchor: 'middle', size: 11, fill: C.faint }),
    );
  });

  return svg(W, H, parts.join('\n'));
}

// ---------------------------------------------------------------- each
// A list in, the same box applied to every element, a list out. The dashed box
// is drawn once per element on purpose: it is one <do>, run four times.
function eachFigure() {
  const W = 700;
  const H = 210;
  const inputs = [1, 2, 3, 4];
  const outputs = [10, 20, 30, 40];
  const x0 = 96;
  const step = 140;
  const parts = [ARROW];

  parts.push(badge(28, 42, 'A', { color: C.drawn }));
  parts.push(badge(28, 108, 'B', { color: C.mark }));
  parts.push(badge(28, 176, 'C', { color: C.made }));

  inputs.forEach((v, i) => {
    const x = x0 + i * step;
    parts.push(cell(x, 26, 44, 34, String(v), { stroke: C.drawn }));
    parts.push(arrow(x + 22, 62, x + 22, 90));
    parts.push(cell(x - 8, 92, 60, 34, '×10', { stroke: C.mark, dash: '5 4' }));
    parts.push(arrow(x + 22, 128, x + 22, 158));
    parts.push(cell(x, 160, 44, 34, String(outputs[i]), { stroke: C.made }));
  });

  return svg(W, H, parts.join('\n'));
}

// ---------------------------------------------------------------- pipe
// The whole shape of a <compute>: columns in, operations in the middle, one
// value out. The values are the login example from the overview page.
function pipeFigure() {
  const W = 780;
  const H = 210;
  const parts = [ARROW];

  // A — the two drawn columns
  parts.push(badge(22, 103, 'A', { color: C.drawn }));
  parts.push(cell(46, 16, 96, 34, 'James', { stroke: C.drawn }));
  parts.push(cell(46, 156, 96, 34, 'Williams', { stroke: C.drawn }));

  // B — the operations, innermost first
  parts.push(badge(372, 62, 'B', { color: C.mark }));
  parts.push(cell(186, 16, 96, 34, '<slice>', { stroke: C.mark, size: 12 }));
  parts.push(cell(336, 86, 104, 34, '<concat>', { stroke: C.mark, size: 12 }));
  parts.push(cell(486, 86, 96, 34, '<lower>', { stroke: C.mark, size: 12 }));

  // C — what <result> hands back
  parts.push(badge(690, 62, 'C', { color: C.made }));
  parts.push(cell(630, 86, 120, 34, 'jwilliams', { stroke: C.made }));

  parts.push(arrow(142, 33, 182, 33));
  parts.push(arrow(282, 33, 332, 98));
  parts.push(arrow(142, 173, 332, 112));
  parts.push(arrow(440, 103, 482, 103));
  parts.push(arrow(582, 103, 626, 103));

  return svg(W, H, parts.join('\n'));
}

// ---------------------------------------------------------------- border
// The string/number border, drawn as a border: one crossing you have to write
// out, one that happens on its own. The dashed line is the frontier itself.
function borderFigure() {
  const W = 700;
  const H = 200;
  const parts = [ARROW];

  parts.push(
    `<line x1="266" y1="8" x2="266" y2="192" stroke="${C.faint}" stroke-width="1.4" stroke-dasharray="6 5"/>`,
  );

  // A — the string side, D — the number side
  parts.push(badge(22, 40, 'A', { color: C.drawn }));
  parts.push(badge(506, 40, 'D', { color: C.made }));

  // B — the crossing you write
  parts.push(badge(266, 14, 'B', { color: C.mark }));
  parts.push(cell(46, 26, 100, 36, '"0042"', { stroke: C.drawn }));
  parts.push(cell(202, 26, 128, 36, '<to_number>', { stroke: C.mark, size: 12 }));
  parts.push(cell(386, 26, 90, 36, '42', { stroke: C.made }));
  parts.push(arrow(150, 44, 198, 44));
  parts.push(arrow(334, 44, 382, 44));

  // C — the crossing that happens on its own
  parts.push(badge(266, 186, 'C', { color: C.mark }));
  parts.push(cell(386, 118, 90, 36, '42', { stroke: C.made }));
  parts.push(cell(202, 118, 128, 36, '<concat>', { stroke: C.mark, dash: '5 4', size: 12 }));
  parts.push(cell(46, 118, 100, 36, '"42"', { stroke: C.drawn }));
  parts.push(arrow(382, 136, 334, 136));
  parts.push(arrow(198, 136, 150, 136));

  return svg(W, H, parts.join('\n'));
}

// ---------------------------------------------------------------- choose
// A fork read top to bottom. The subject is 7, so the first test holds and the
// two lower branches are never reached — drawn faint, because that is the point.
function chooseFigure() {
  const W = 620;
  const H = 250;
  const parts = [ARROW, EXTRA_HEADS];

  // A — the value every branch is asked about
  parts.push(badge(22, 37, 'A', { color: C.drawn }));
  parts.push(cell(46, 20, 60, 34, '7', { stroke: C.drawn }));

  // B — the tests, in the order they are written
  parts.push(badge(140, 117, 'B', { color: C.mark }));
  const rows = [
    { y: 20, test: '> 5', value: '100', mark: '✓' },
    { y: 100, test: '> 2', value: '50', mark: '✗' },
    // the tail has no test to pass or fail, so it carries no mark
    { y: 180, test: '<otherwise>', value: '0', mark: '' },
  ];
  for (const r of rows) {
    const taken = r.mark === '✓';
    const ink = taken ? C.mark : C.faint;
    parts.push(cell(160, r.y, 140, 34, r.test, { stroke: ink, size: taken ? 13 : 12 }));
    parts.push(cell(400, r.y, 70, 34, r.value, { stroke: taken ? C.made : C.faint }));
    parts.push(arrow(304, r.y + 17, 396, r.y + 17, { color: ink }));
    // the mark on the arrow: the test held, or it did not
    if (r.mark !== '') {
      parts.push(
        text(348, r.y + 11, r.mark, { anchor: 'middle', size: 14, weight: 700, fill: ink }),
      );
    }
  }
  parts.push(arrow(110, 37, 156, 37));
  parts.push(arrow(230, 58, 230, 96, { color: C.faint }));
  parts.push(arrow(230, 138, 230, 176, { color: C.faint }));

  // C — the branch that answered
  parts.push(badge(510, 37, 'C', { color: C.made }));
  parts.push(arrow(474, 37, 500, 37, { color: C.made }));

  return svg(W, H, parts.join('\n'));
}

writeFileSync(join(OUT, 'reduce.svg'), reduceFigure());
writeFileSync(join(OUT, 'each.svg'), eachFigure());
writeFileSync(join(OUT, 'pipe.svg'), pipeFigure());
writeFileSync(join(OUT, 'border.svg'), borderFigure());
writeFileSync(join(OUT, 'choose.svg'), chooseFigure());
console.log('wrote 5 figures to static/img/compute');
