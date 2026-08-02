/**
 * Figures for the topics that are hardest to carry in prose: the layers of a
 * time series, where the fixtures land in the output, a mask applied character
 * by character, and how a pack address resolves across the three axes.
 *
 * Language-free by the rule in figure-kit.mjs. Identifiers and attribute
 * spellings are code and stay inside the drawing; everything else is a letter
 * badge decoded by <Legend>.
 *
 * Run:  node webdoc/scripts/make-concept-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARROW,
  C,
  badge,
  box,
  dots,
  frame,
  makeRunner,
  oneColumn,
  svg,
  text,
} from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'concepts');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'concepts');

mkdirSync(OUT, { recursive: true });

const W = 680;
const PAD_L = 56;
const PAD_R = 30;
const TOP = 18;

const FIGURES = {};

// ------------------------------------------------------- 1. time-series layers

/**
 * The four attributes, switched on one at a time. Each panel is a real run, so
 * the reader sees exactly what each word in the config adds to the shape.
 */
FIGURES['timeseries-layers'] = () => {
  const N = 120;
  const series = (attrs) =>
    run(oneColumn(`<gen type="timeseries" ${attrs}/>`, N, 'doc')).map(Number);
  const layers = [
    ['base="1000"', 'A'],
    ['base="1000" trend="20"', 'B'],
    ['base="1000" trend="20" period="7" amplitude="150"', 'C'],
    ['base="1000" trend="20" period="7" amplitude="150" noise="30"', 'D'],
  ].map(([attrs, letter]) => ({ vals: series(attrs), attrs, letter }));

  const lo = Math.min(...layers.flatMap((l) => l.vals));
  const hi = Math.max(...layers.flatMap((l) => l.vals));
  const panels = layers.map((l, i) => {
    const b = box(PAD_L, TOP + i * 92, W - PAD_L - PAD_R, 62, [lo, hi]);
    return [
      frame(b, { yTicks: [Math.round(lo), Math.round(hi)] }),
      dots(b, l.vals, { r: 1.9 }),
      badge(b.x - 32, b.y + 31, l.letter),
      // Attribute spellings are code: identical in every language.
      text(b.x + 4, b.y + b.h + 18, l.attrs, { size: 11 }),
    ].join('\n');
  });
  return svg(W, TOP + 4 * 92 + 6, panels.join('\n'));
};

// ------------------------------------------------- 2. where the fixtures land

/**
 * The output as a stack of bands, in the order they are printed. A reader can
 * count the bands and see that `delimiter_block` sits BETWEEN cards and never
 * after the last one — the part that prose keeps failing to make obvious.
 */
FIGURES['output-layout'] = () => {
  const x = 150;
  const w = 380;
  let y = 24;
  const parts = [];
  const band = (label, colour, opacity, letter, h = 24) => {
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${colour}" opacity="${opacity}"/>`,
    );
    if (letter) parts.push(badge(x - 26, y + h / 2, letter));
    if (label) {
      parts.push(text(x + w + 14, y + h / 2 + 4, label, { size: 11.5, fill: C.text }));
    }
    y += h + 6;
  };

  band('before', C.mark, 0.25, 'A');
  y += 6;
  // Card 1
  band('before_block', C.drawn, 0.3, 'B');
  band('line', C.made, 0.75, 'C');
  band('delimiter_line', C.faint, 0.5, 'D', 12);
  band('line', C.made, 0.75);
  band('after_block', C.drawn, 0.3, 'E');
  band('delimiter_block', C.mark, 0.45, 'F', 12);
  // Card 2 — same shape, so the reader can see what repeats
  band('before_block', C.drawn, 0.3);
  band('line', C.made, 0.75);
  band('delimiter_line', C.faint, 0.5, null, 12);
  band('line', C.made, 0.75);
  band('after_block', C.drawn, 0.3);
  y += 6;
  band('after', C.mark, 0.25, 'G');

  // A bracket marking the two cards, so "per card" is visible rather than stated.
  const cardTop = 24 + 24 + 6 + 6;
  const cardBottom = y - 24 - 6 - 6;
  parts.push(
    `<path d="M${x - 52} ${cardTop} h -8 v ${cardBottom - cardTop} h 8" fill="none" stroke="${C.axis}" stroke-width="1.4" opacity="0.7"/>`,
    badge(x - 78, (cardTop + cardBottom) / 2, 'H'),
  );
  return svg(W, y + 8, parts.join('\n'));
};

// ---------------------------------------------------------- 3. a mask, in situ

/** The mask consumed character by character: a source digit or a literal. */
FIGURES['mask'] = () => {
  const MASK = 'xxx-xx-xxxx';
  const value = run(oneColumn(`<gen type="number" length="9" first_zero="true"/>`, 1, 'doc'))[0];
  const masked = run(
    oneColumn(`<gen type="number" length="9" first_zero="true" mask="${MASK}"/>`, 1, 'doc'),
  )[0];

  const cell = 30;
  const gap = 5;
  const rowY = (i) => 26 + i * 74;
  const parts = [ARROW.replace(`fill="${C.mark}"`, `fill="${C.axis}"`)];

  // Row 1: the raw digits.
  value.split('').forEach((ch, i) => {
    const x = PAD_L + i * (cell + gap);
    parts.push(
      `<rect x="${x}" y="${rowY(0)}" width="${cell}" height="${cell}" rx="6" fill="${C.drawn}" opacity="0.85"/>`,
      text(x + cell / 2, rowY(0) + cell / 2 + 5, ch, {
        anchor: 'middle',
        size: 14,
        weight: 700,
        fill: '#fff',
      }),
    );
  });
  parts.push(badge(PAD_L - 26, rowY(0) + cell / 2, 'A'));

  // Row 2: the mask pattern, one cell per character.
  MASK.split('').forEach((ch, i) => {
    const x = PAD_L + i * (cell + gap);
    const isSlot = ch === 'x';
    parts.push(
      `<rect x="${x}" y="${rowY(1)}" width="${cell}" height="${cell}" rx="6" fill="${isSlot ? C.mark : C.axis}" opacity="${isSlot ? 0.3 : 0.18}"/>`,
      text(x + cell / 2, rowY(1) + cell / 2 + 5, ch, {
        anchor: 'middle',
        size: 14,
        weight: 700,
        fill: isSlot ? C.mark : C.text,
      }),
    );
  });
  parts.push(badge(PAD_L - 26, rowY(1) + cell / 2, 'B'));

  // Row 3: the result.
  masked.split('').forEach((ch, i) => {
    const x = PAD_L + i * (cell + gap);
    const fromMask = MASK[i] !== 'x';
    parts.push(
      `<rect x="${x}" y="${rowY(2)}" width="${cell}" height="${cell}" rx="6" fill="${fromMask ? C.axis : C.made}" opacity="${fromMask ? 0.2 : 0.85}"/>`,
      text(x + cell / 2, rowY(2) + cell / 2 + 5, ch, {
        anchor: 'middle',
        size: 14,
        weight: 700,
        fill: fromMask ? C.text : '#fff',
      }),
    );
  });
  parts.push(badge(PAD_L - 26, rowY(2) + cell / 2, 'C'));

  // Arrows from each source digit to the slot that consumed it.
  let src = 0;
  MASK.split('').forEach((ch, i) => {
    if (ch !== 'x') return;
    const from = PAD_L + src * (cell + gap) + cell / 2;
    const to = PAD_L + i * (cell + gap) + cell / 2;
    parts.push(
      `<path d="M${from} ${rowY(0) + cell + 3} C ${from} ${rowY(0) + cell + 22}, ${to} ${rowY(2) - 22}, ${to} ${rowY(2) - 4}" fill="none" stroke="${C.axis}" stroke-width="1.1" opacity="0.55"/>`,
    );
    src += 1;
  });

  return svg(W, rowY(2) + cell + 20, parts.join('\n'));
};

// ------------------------------------------------------- 4. the three pack axes

/**
 * Why one address resolves to different data in different runs: three
 * independent axes, each contributing its own bucket of packs.
 */
FIGURES['pack-axes'] = () => {
  const laneH = 46;
  const x0 = 190;
  const w = 320;
  const lanes = [
    ['common', C.mark, 'A'],
    ['en / ru / es …', C.drawn, 'B'],
    ['usa / russia …', C.made, 'C'],
  ];
  const parts = [ARROW.replace(`fill="${C.mark}"`, `fill="${C.axis}"`)];
  lanes.forEach(([label, colour, letter], i) => {
    const y = 40 + i * (laneH + 12);
    parts.push(
      `<rect x="${x0}" y="${y}" width="${w}" height="${laneH}" rx="8" fill="${colour}" opacity="0.18"/>`,
      `<rect x="${x0}" y="${y}" width="${w}" height="${laneH}" rx="8" fill="none" stroke="${colour}" opacity="0.6"/>`,
      // Axis names are directory names — code, not prose.
      text(x0 + 16, y + laneH / 2 + 5, label, { size: 13, weight: 700, fill: colour }),
      badge(x0 - 26, y + laneH / 2, letter),
    );
  });

  // One address, drawn once, reaching into all three lanes.
  const addrY = 40 + 3 * (laneH + 12) + 26;
  parts.push(
    text(x0, addrY + 5, 'person.male.firstName', { size: 13, weight: 700 }),
    badge(x0 - 26, addrY, 'D'),
  );
  for (let i = 0; i < 3; i++) {
    const y = 40 + i * (laneH + 12) + laneH / 2;
    parts.push(
      `<path d="M${x0 - 60} ${addrY} C ${x0 - 110} ${addrY}, ${x0 - 110} ${y}, ${x0 - 52} ${y}" fill="none" stroke="${C.axis}" stroke-width="1.4" opacity="0.7" marker-end="url(#a)"/>`,
    );
  }
  return svg(W, addrY + 30, parts.join('\n'));
};

for (const [name, build] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), build());
}

console.log(`concepts: ${Object.keys(FIGURES).length} language-free figures → ${OUT}`);
