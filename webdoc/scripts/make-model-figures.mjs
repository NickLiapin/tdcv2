/**
 * Figures for the model itself: what a sequence is, what a list-valued cell is,
 * what `row=` links together, and how a typed file is laid out.
 *
 * Language-free by the rule in figure-kit.mjs — the sample data is latin letters
 * and digits so nothing inside a picture ever needs translating.
 *
 * Run:  node webdoc/scripts/make-model-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARROW, C, badge, box, frame, makeRunner, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'concepts');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'model');

mkdirSync(OUT, { recursive: true });

const W = 680;
const FIGURES = {};

const cellBox = (x, y, w, h, fill, opacity, label, labelFill = '#fff') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" opacity="${opacity}"/>` +
  text(x + w / 2, y + h / 2 + 5, label, {
    anchor: 'middle',
    size: 13,
    weight: 700,
    fill: labelFill,
  });

// -------------------------------------------- 1. a sequence is a column

/**
 * The one idea the whole language rests on: each sequence is a column, filled
 * independently down the run, and a row is what you get by reading across them.
 */
FIGURES['sequences'] = () => {
  const rows = run(
    `<tdc><env count="6" seed="doc">
      <sequence name="P"><gen type="text" value="A,B,C"/></sequence>
      <sequence name="Q"><gen type="number" value="1..9"/></sequence>
      <sequence name="R"><gen type="text" value="X,Y"/></sequence>
    </env><block><line><data>\${{P}} \${{Q}} \${{R}}</data></line></block></tdc>`,
  ).map((l) => l.split(' '));

  const colX = [90, 190, 290];
  const colColour = [C.drawn, C.made, C.alt];
  const cw = 68;
  const ch = 30;
  const y0 = 46;
  const parts = [ARROW.replace(`fill="${C.mark}"`, `fill="${C.axis}"`)];

  rows.forEach((r, i) => {
    r.forEach((v, c) => {
      parts.push(cellBox(colX[c], y0 + i * (ch + 6), cw, ch, colColour[c], 0.85, v));
    });
  });
  for (let c = 0; c < 3; c++) parts.push(badge(colX[c] + cw / 2, y0 - 18, 'ABC'[c]));

  // One row lifted out of the columns and assembled into an output line.
  const pick = 2;
  const py = y0 + pick * (ch + 6);
  parts.push(
    `<rect x="${colX[0] - 8}" y="${py - 5}" width="${colX[2] + cw + 8 - colX[0] + 8}" height="${ch + 10}" rx="9" fill="none" stroke="${C.mark}" stroke-width="2"/>`,
    `<line x1="${colX[2] + cw + 14}" y1="${py + ch / 2}" x2="${470}" y2="${py + ch / 2}" stroke="${C.axis}" stroke-width="1.6" marker-end="url(#a)"/>`,
    cellBox(482, py, 150, ch, C.mark, 0.22, rows[pick].join(' '), C.text),
    badge(560, py - 24, 'D'),
  );
  return svg(W, y0 + rows.length * (ch + 6) + 16, parts.join('\n'));
};

// ------------------------------------------- 2. a cell that holds a list

/** Rows whose cell holds several values, and the exact quota of list lengths. */
FIGURES['repeat-lists'] = () => {
  const N = 2000;
  const rows = run(
    `<tdc><env count="${N}" seed="doc"><sequence name="L">
      <gen type="text" value="A,B,C,D" repeat="1..4" separator=","/>
    </sequence></env><block><line><data>\${{L}}</data></line></block></tdc>`,
  );
  const lengths = rows.map((r) => r.split(',').length);
  const counts = [1, 2, 3, 4].map((n) => lengths.filter((l) => l === n).length);

  const cw = 30;
  const ch = 28;
  const x0 = 60;
  const y0 = 34;
  const parts = [];
  rows.slice(0, 8).forEach((r, i) => {
    r.split(',').forEach((v, k) => {
      parts.push(cellBox(x0 + k * (cw + 5), y0 + i * (ch + 5), cw, ch, C.made, 0.85, v));
    });
  });
  parts.push(badge(x0 - 24, y0 + 4 * (ch + 5), 'A'));

  // The length quota: how many rows came out with 1, 2, 3, 4 values.
  const b = box(300, y0 + 8, 320, 218, [0, Math.max(...counts) * 1.15]);
  const bw = b.w / 4;
  counts.forEach((n, i) => {
    const x = b.x + i * bw + 14;
    parts.push(
      `<rect x="${x}" y="${b.sy(n).toFixed(1)}" width="${bw - 28}" height="${(b.y + b.h - b.sy(n)).toFixed(1)}" rx="4" fill="${C.made}" opacity="0.8"/>`,
      text(x + (bw - 28) / 2, b.sy(n) - 6, String(n), { anchor: 'middle' }),
      text(x + (bw - 28) / 2, b.y + b.h + 18, String(i + 1), {
        anchor: 'middle',
        size: 13,
        weight: 700,
      }),
    );
  });
  parts.push(
    `<line x1="${b.x}" y1="${b.y + b.h}" x2="${b.x + b.w}" y2="${b.y + b.h}" stroke="${C.axis}" opacity="0.55"/>`,
    badge(b.x - 20, b.y + b.h / 2, 'B'),
    text(b.x, b.y - 8, `n = ${N}`, { size: 11 }),
  );
  return svg(W, y0 + 8 * (ch + 5) + 40, parts.join('\n'));
};

// ------------------------------------------------- 3. what `row=` links

/**
 * The same CSV read twice: without `row=` each field picks its own line, with it
 * they all read one. Drawn as the source table plus the two outputs.
 */
FIGURES['csv-row-link'] = () => {
  const csv = join(tmpdir(), 'tdc-figure-users.csv');
  const TABLE = [
    ['a', '1', 'X'],
    ['b', '2', 'Y'],
    ['c', '3', 'Z'],
    ['d', '4', 'W'],
  ];
  writeFileSync(csv, `one,two,three\n${TABLE.map((r) => r.join(',')).join('\n')}\n`);

  const read = (rowAttr) =>
    run(
      `<tdc><env count="6" seed="doc"><sequence name="U">
        <gen name="A" type="file" src="${csv}" column="one" header="true"${rowAttr}/>
        <gen name="B" type="file" src="${csv}" column="two" header="true"${rowAttr}/>
        <gen name="C" type="file" src="${csv}" column="three" header="true"${rowAttr}/>
      </sequence></env><block><line><data>\${{U.A}}\${{U.B}}\${{U.C}}</data></line></block></tdc>`,
    );
  const loose = read('');
  const linked = read(' row="u"');

  const cw = 34;
  const ch = 28;
  const parts = [];
  // The source table.
  TABLE.forEach((r, i) => {
    r.forEach((v, c) => {
      parts.push(cellBox(60 + c * (cw + 4), 44 + i * (ch + 4), cw, ch, C.drawn, 0.85, v));
    });
  });
  parts.push(badge(36, 44 + 1.5 * (ch + 4), 'A'));

  // Two readings of it, side by side.
  const column = (x, data, letter) => {
    const out = [badge(x + 1.5 * (cw + 4) - cw / 2, 24, letter)];
    data.forEach((line, i) => {
      line.split('').forEach((v, c) => {
        // A triple is coherent when all three cells come from one source line.
        const rowOf = (val, col) => TABLE.findIndex((t) => t[col] === val);
        const same = rowOf(line[0], 0) === rowOf(v, c);
        out.push(
          cellBox(x + c * (cw + 4), 44 + i * (ch + 4), cw, ch, same ? C.made : C.faint, 0.85, v),
        );
      });
    });
    return out.join('');
  };
  parts.push(column(250, loose, 'B'), column(440, linked, 'C'));

  return svg(W, 44 + 6 * (ch + 4) + 16, parts.join('\n'));
};

// ------------------------------------------------ 4. the shape of a typed file

/** A columnar file: row groups down, column chunks across. Schematic. */
FIGURES['parquet-layout'] = () => {
  const parts = [];
  const x0 = 150;
  const colW = 110;
  const groupH = 58;
  const cols = 3;
  const groups = 3;
  for (let g = 0; g < groups; g++) {
    const y = 44 + g * (groupH + 12);
    parts.push(
      `<rect x="${x0 - 8}" y="${y - 8}" width="${cols * (colW + 8) + 8}" height="${groupH + 16}" rx="10" fill="${C.mark}" opacity="0.08"/>`,
      `<rect x="${x0 - 8}" y="${y - 8}" width="${cols * (colW + 8) + 8}" height="${groupH + 16}" rx="10" fill="none" stroke="${C.mark}" opacity="0.45"/>`,
    );
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * (colW + 8);
      parts.push(
        `<rect x="${x}" y="${y}" width="${colW}" height="${groupH}" rx="6" fill="${[C.drawn, C.made, C.alt][c]}" opacity="0.75"/>`,
      );
    }
    if (g === 0) {
      parts.push(badge(x0 - 34, y + groupH / 2, 'A'));
      for (let c = 0; c < cols; c++) {
        parts.push(badge(x0 + c * (colW + 8) + colW / 2, y - 26, 'BCD'[c]));
      }
    }
    // The row count of a group is a real number from the writer's defaults.
    parts.push(text(x0 + cols * (colW + 8) + 14, y + groupH / 2 + 4, '50 000', { size: 11.5 }));
  }
  return svg(W, 44 + groups * (groupH + 12) + 20, parts.join('\n'));
};

for (const [name, build] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), build());
}

console.log(`model: ${Object.keys(FIGURES).length} language-free figures → ${OUT}`);
