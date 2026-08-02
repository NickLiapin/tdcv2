/**
 * Figures for switch, distinct/uniq, relational output and compute.
 *
 * All four show real output from the real CLI, and all four are language-free by
 * the rule in figure-kit.mjs: the generated values are latin letters and digits
 * on purpose, so the pictures carry no words to translate.
 *
 * Run:  node webdoc/scripts/make-structure-figures.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARROW, C, badge, makeRunner, svg, text } from './figure-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, '..', 'static', 'img', 'guides');
const run = makeRunner(join(ROOT, 'typescript', 'dist', 'cli', 'main.js'), 'structure');

mkdirSync(OUT, { recursive: true });

const W = 680;
const KEYS = ['A', 'B', 'C'];
const KEY_COLOUR = { A: C.drawn, B: C.alt, C: C.made };

const FIGURES = {};

// ------------------------------------------------------------------ 1. switch

/**
 * A lookup table beside the rows it produced: the subject decides the result, so
 * the same letter always carries the same number. (A `<mix>` would not.)
 */
FIGURES['switch'] = () => {
  const rows = run(
    `<tdc><env count="24" seed="doc">
      <sequence name="S"><gen type="text" value="A,B,C"/></sequence>
      <switch name="R" on="S"><map>A:1, B:2, C:3</map></switch>
    </env><block><line><data>\${{S}}\${{R}}</data></line></block></tdc>`,
  );

  // The map itself, drawn as three key → value pairs.
  const mapX = 46;
  const mapY = 34;
  const table = KEYS.map((k, i) => {
    const y = mapY + i * 34;
    return (
      `<rect x="${mapX}" y="${y}" width="28" height="26" rx="5" fill="${KEY_COLOUR[k]}" opacity="0.85"/>` +
      `<text x="${mapX + 14}" y="${y + 18}" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">${k}</text>` +
      `<line x1="${mapX + 34}" y1="${y + 13}" x2="${mapX + 60}" y2="${y + 13}" stroke="${C.axis}" stroke-width="1.6" marker-end="url(#a)"/>` +
      `<text x="${mapX + 76}" y="${y + 18}" text-anchor="middle" font-size="13" font-weight="700" fill="${KEY_COLOUR[k]}">${i + 1}</text>`
    );
  }).join('');

  const gridX = 216;
  const cell = 26;
  const cols = 12;
  const grid = rows
    .map((r, i) => {
      const x = gridX + (i % cols) * (cell + 8);
      const y = mapY + Math.floor(i / cols) * (cell + 28);
      const colour = KEY_COLOUR[r[0]];
      return (
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="5" fill="${colour}" opacity="0.85"/>` +
        `<text x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${r[0]}</text>` +
        `<text x="${x + cell / 2}" y="${y + cell + 16}" text-anchor="middle" font-size="12" fill="${colour}">${r[1]}</text>`
      );
    })
    .join('');

  return svg(
    W,
    mapY + 3 * 34 + 20,
    [
      ARROW.replace(`fill="${C.mark}"`, `fill="${C.axis}"`),
      table,
      grid,
      badge(mapX - 22, mapY + 46, 'A'),
      badge(gridX - 22, mapY + 46, 'B'),
    ].join('\n'),
  );
};

// ------------------------------------------------------- 2. distinct vs uniq

/**
 * Both rules on one pair of axes: X across, Y down, a count in every cell.
 * `<distinct>` empties the diagonal (a row may not repeat a value across its
 * fields); `<uniq>` caps every cell at one (a combination may not repeat across
 * rows). Two different constraints, one picture.
 */
FIGURES['distinct-uniq'] = () => {
  const pairs = (config, yIndex) => run(config).map((r) => [KEYS.indexOf(r[0]), yIndex(r[1])]);
  // Both fields draw from the SAME pool — otherwise `<distinct>` has nothing to
  // forbid (a letter can never equal a digit) and the figure would show a rule
  // that never fired.
  const distinct = pairs(
    `<tdc><env count="60" seed="doc"><distinct>
      <sequence name="X"><gen type="text" value="A,B,C"/></sequence>
      <sequence name="Y"><gen type="text" value="A,B,C"/></sequence>
    </distinct></env><block><line><data>\${{X}}\${{Y}}</data></line></block></tdc>`,
    (v) => KEYS.indexOf(v),
  );
  // SIX rows out of the nine possible combinations, deliberately not nine.
  // At nine the grid comes out completely filled with 1s, and the picture then
  // reads as "uniq uses every combination exactly once" — which is not the rule.
  // The rule is "no combination TWICE": at most one, and empty cells are normal.
  const uniq = pairs(
    `<tdc><env count="6" seed="doc"><uniq>
      <sequence name="X"><gen type="text" value="A,B,C"/></sequence>
      <sequence name="Y"><gen type="text" value="1,2,3"/></sequence>
    </uniq></env><block><line><data>\${{X}}\${{Y}}</data></line></block></tdc>`,
    (v) => Number(v) - 1,
  );

  const matrix = (data, x0, letter, diagonalIsForbidden, rowKeys) => {
    const counts = [0, 1, 2].map(() => [0, 0, 0]);
    for (const [xi, yi] of data) if (xi >= 0 && yi >= 0) counts[yi][xi] += 1;
    const cell = 46;
    const y0 = 46;
    const parts = [badge(x0 - 20, y0 - 16, letter)];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const x = x0 + c * cell;
        const y = y0 + r * cell;
        const n = counts[r][c];
        const forbidden = diagonalIsForbidden && r === c;
        parts.push(
          `<rect x="${x}" y="${y}" width="${cell - 4}" height="${cell - 4}" rx="6" fill="${n === 0 ? C.axis : C.made}" opacity="${n === 0 ? 0.12 : 0.16 + Math.min(0.3, n / 50)}"/>`,
          text(x + (cell - 4) / 2, y + (cell - 4) / 2 + 5, String(n), {
            anchor: 'middle',
            size: 13,
            fill: n === 0 ? C.axis : C.text,
            weight: 700,
          }),
        );
        if (forbidden) {
          parts.push(
            `<line x1="${x + 8}" y1="${y + 8}" x2="${x + cell - 12}" y2="${y + cell - 12}" stroke="${C.mark}" stroke-width="1.6" opacity="0.7"/>`,
            `<line x1="${x + cell - 12}" y1="${y + 8}" x2="${x + 8}" y2="${y + cell - 12}" stroke="${C.mark}" stroke-width="1.6" opacity="0.7"/>`,
          );
        }
      }
    }
    // Axis keys: latin letters across, digits down — the generated values.
    for (let c = 0; c < 3; c++) {
      parts.push(
        text(x0 + c * cell + (cell - 4) / 2, y0 - 8, KEYS[c], {
          anchor: 'middle',
          size: 13,
          weight: 700,
          fill: KEY_COLOUR[KEYS[c]],
        }),
      );
    }
    for (let r = 0; r < 3; r++) {
      parts.push(
        text(x0 - 10, y0 + r * cell + (cell - 4) / 2 + 5, rowKeys[r], {
          anchor: 'end',
          size: 13,
          weight: 700,
          ...(rowKeys === KEYS ? { fill: KEY_COLOUR[KEYS[r]] } : {}),
        }),
      );
    }
    return parts.join('');
  };

  return svg(
    W,
    226,
    [matrix(distinct, 90, 'A', true, KEYS), matrix(uniq, 420, 'B', false, ['1', '2', '3'])].join(
      '\n',
    ),
  );
};

// --------------------------------------------------------- 3. relational rows

/** Parent rows and child rows from one run, with the link drawn. */
FIGURES['relational'] = () => {
  const lines = run(
    `<tdc><env count="4" seed="doc">
      <sequence name="Id"><gen type="increment"/></sequence>
      <sequence name="Ord"><gen type="number" value="100..999" repeat="1..3"/></sequence>
    </env><block>
      <line><data>C,\${{Id}}</data></line>
      <line each="Ord"><data>O,\${{Id}},\${{Ord}}</data></line>
    </block></tdc>`,
  );
  const customers = [];
  for (const l of lines) {
    const [kind, id, value] = l.split(',');
    if (kind === 'C') customers.push({ id, orders: [] });
    else customers.find((c) => c.id === id)?.orders.push(value);
  }

  const cw = 92;
  const ow = 92;
  const rowH = 34;
  const leftX = 96;
  const rightX = 400;
  let y = 34;
  const parts = [ARROW.replace(`fill="${C.mark}"`, `fill="${C.axis}"`)];
  for (const c of customers) {
    const span = Math.max(1, c.orders.length);
    const cy = y + ((span - 1) * rowH) / 2;
    parts.push(
      `<rect x="${leftX}" y="${cy}" width="${cw}" height="26" rx="6" fill="${C.drawn}" opacity="0.85"/>`,
      text(leftX + cw / 2, cy + 18, c.id, {
        anchor: 'middle',
        size: 13,
        weight: 700,
        fill: '#fff',
      }),
    );
    c.orders.forEach((o, k) => {
      const oy = y + k * rowH;
      parts.push(
        `<path d="M${leftX + cw + 6} ${cy + 13} C ${leftX + cw + 60} ${cy + 13}, ${rightX - 60} ${oy + 13}, ${rightX - 8} ${oy + 13}" fill="none" stroke="${C.axis}" stroke-width="1.4" opacity="0.75" marker-end="url(#a)"/>`,
        `<rect x="${rightX}" y="${oy}" width="${ow}" height="26" rx="6" fill="${C.made}" opacity="0.85"/>`,
        text(rightX + ow / 2, oy + 18, o, {
          anchor: 'middle',
          size: 13,
          weight: 700,
          fill: '#fff',
        }),
        // The foreign key, printed on the child row exactly as it lands in output.
        text(rightX + ow + 12, oy + 18, c.id, { size: 12, fill: C.drawn, weight: 700 }),
      );
    });
    y += span * rowH + 10;
  }
  return svg(
    W,
    y + 10,
    [...parts, badge(leftX - 26, 47, 'A'), badge(rightX - 26, 47, 'B')].join('\n'),
  );
};

// ------------------------------------------------------------- 4. compute

/**
 * The Luhn example from the compute page, with its arithmetic laid out: the
 * generated digits, the doubling of every second one, the sum, and the digit
 * that makes the total land on a multiple of ten. Numbers only.
 */
FIGURES['compute'] = () => {
  const card = run(
    `<tdc><env count="1" seed="figure">
      <sequence name="Base"><gen type="number" length="15" first_zero="false"/></sequence>
      <sequence name="Card">
        <compute>
          <let name="sum">
            <reduce>
              <over><field name="Base"/></over>
              <init><int v="0"/></init>
              <do><add><acc/>
                <choose>
                  <when>
                    <test><equals><mod><current_index/><int v="2"/></mod><int v="0"/></equals></test>
                    <then><at><in><list v="0,2,4,6,8,1,3,5,7,9"/></in><index><current/></index></at></then>
                  </when>
                  <otherwise><current/></otherwise>
                </choose>
              </add></do>
            </reduce>
          </let>
          <let name="check">
            <mod><subtract><int v="10"/><mod><var name="sum"/><int v="10"/></mod></subtract><int v="10"/></mod>
          </let>
          <result><concat><field name="Base"/><var name="check"/></concat></result>
        </compute>
      </sequence>
    </env><block><line><data>\${{Card}}</data></line></block></tdc>`,
  )[0];

  const base = card.slice(0, 15).split('');
  const check = card.slice(15);
  // The same arithmetic, recomputed here: if these two disagree the figure is a lie.
  const DOUBLED = [0, 2, 4, 6, 8, 1, 3, 5, 7, 9];
  const weights = base.map((d, i) => (i % 2 === 0 ? DOUBLED[Number(d)] : Number(d)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const expected = (10 - (sum % 10)) % 10;
  if (String(expected) !== check) {
    throw new Error(`compute figure: engine check digit ${check} != recomputed ${expected}`);
  }

  const cell = 30;
  const x0 = 46;
  const y0 = 40;
  const digits = base
    .map((d, i) => {
      const x = x0 + i * (cell + 4);
      return (
        `<rect x="${x}" y="${y0}" width="${cell}" height="${cell}" rx="6" fill="${C.drawn}" opacity="0.85"/>` +
        `<text x="${x + cell / 2}" y="${y0 + cell / 2 + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">${d}</text>` +
        // The weighted value under every digit; the doubled ones are marked.
        text(x + cell / 2, y0 + cell + 18, String(weights[i]), {
          anchor: 'middle',
          size: 12,
          fill: i % 2 === 0 ? C.mark : C.text,
          weight: i % 2 === 0 ? 700 : 400,
        })
      );
    })
    .join('');
  const cx = x0 + 15 * (cell + 4);
  const checkCell =
    `<rect x="${cx}" y="${y0}" width="${cell}" height="${cell}" rx="6" fill="${C.made}"/>` +
    `<text x="${cx + cell / 2}" y="${y0 + cell / 2 + 5}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">${check}</text>`;

  const eqY = y0 + cell + 58;
  const equation =
    text(x0, eqY, `${weights.join(' + ')} = ${sum}`, { size: 12.5 }) +
    text(x0, eqY + 22, `(10 − ${sum} mod 10) mod 10 = ${check}`, { size: 12.5 }) +
    text(x0, eqY + 44, `(${sum} + ${check}) mod 10 = 0`, { size: 12.5, fill: C.made, weight: 700 });

  return svg(
    W,
    eqY + 60,
    [
      digits,
      checkCell,
      badge(x0 - 22, y0 + cell / 2, 'A'),
      badge(cx + cell + 22, y0 + cell / 2, 'B'),
      badge(x0 - 22, eqY - 5, 'C'),
      equation,
    ].join('\n'),
  );
};

for (const [name, build] of Object.entries(FIGURES)) {
  writeFileSync(join(OUT, `${name}.svg`), build());
}

console.log(`structure: ${Object.keys(FIGURES).length} language-free figures → ${OUT}`);
