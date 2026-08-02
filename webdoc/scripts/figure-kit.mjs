/**
 * The shared kit for building documentation figures.
 *
 * TRANSLATION RULE, and the reason this file exists: a figure carries NO words.
 * Numbers are universal and attribute spellings (`y_range="0..40"`) are code, so
 * both may appear inside the drawing. Everything a reader would need translated —
 * what a colour means, what an arrow points at, what a panel shows — is marked
 * with a latin letter badge (A, B, C) and explained in the page text underneath,
 * where it is translated like any other sentence. One SVG then serves every
 * locale, and adding a language never means redrawing anything.
 *
 * Colours are chosen to read on both the light and the dark theme, and are
 * mirrored in src/components/Legend/styles.module.css — change them in both.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const C = {
  axis: '#94a3b8',
  text: '#94a3b8',
  drawn: '#e0662b', // the input: what the user drew or declared
  made: '#2f9e63', // the output: what the engine produced
  mark: '#3b82f6', // annotations, badges, measurements
  faint: '#b0b0b4', // a secondary, deliberately weak element
  alt: '#8b5cf6', // a second output series, when one is not enough
};

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rough advance width — enough to lay rows out and keep things from colliding. */
export const tw = (s, size = 11) => String(s).length * size * 0.53;

export function svg(w, h, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">\n${body}\n</svg>\n`
  );
}

export const ARROW = `<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.mark}"/></marker></defs>`;

export function text(x, y, s, { size = 11, anchor = 'start', fill = C.text, weight = 400 } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;
}

/**
 * A latin letter badge. This is the whole translation trick: the drawing says
 * "A", the page text says what A is, in whatever language the page is written in.
 */
export function badge(x, y, letter, { color = C.mark, r = 9.5 } = {}) {
  return (
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}"/>` +
    `<text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">${esc(letter)}</text>`
  );
}

/** A plotting box. `dom` is the value range of the vertical axis. */
export function box(x, y, w, h, dom = [0, 100]) {
  return {
    x,
    y,
    w,
    h,
    dom,
    sx: (u) => x + u * w,
    sy: (v) => y + h - ((v - dom[0]) / (dom[1] - dom[0])) * h,
  };
}

export function frame(b, { yTicks, xTicks = [], yLabels = true, decimals = 0 } = {}) {
  const ticks = yTicks ?? [b.dom[0], (b.dom[0] + b.dom[1]) / 2, b.dom[1]];
  const parts = [];
  for (const v of ticks) {
    const yy = b.sy(v);
    parts.push(
      `<line x1="${b.x}" y1="${yy.toFixed(1)}" x2="${b.x + b.w}" y2="${yy.toFixed(1)}" stroke="${C.axis}" stroke-width="1" opacity="${v === ticks[0] ? 0.55 : 0.22}"/>`,
    );
    if (yLabels) parts.push(text(b.x - 8, yy + 4, v.toFixed(decimals), { anchor: 'end' }));
  }
  for (const [u, label] of xTicks) {
    const xx = b.sx(u);
    parts.push(
      `<line x1="${xx.toFixed(1)}" y1="${b.y + b.h}" x2="${xx.toFixed(1)}" y2="${b.y + b.h + 4}" stroke="${C.axis}" stroke-width="1" opacity="0.55"/>`,
      text(xx, b.y + b.h + 17, label, { anchor: 'middle' }),
    );
  }
  parts.push(
    `<line x1="${b.x}" y1="${b.y}" x2="${b.x}" y2="${b.y + b.h}" stroke="${C.axis}" stroke-width="1" opacity="0.55"/>`,
  );
  return parts.join('\n');
}

/** First, middle and last row number — the only numbers a row axis needs. */
export const rowTicks = (n) => [
  [0, '1'],
  [0.5, String(Math.round(n / 2))],
  [1, String(n)],
];

export function curvePath(b, f, { color = C.drawn, width = 2.2, dash = '', steps = 240 } = {}) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pts.push(`${b.sx(u).toFixed(1)},${b.sy(f(u)).toFixed(1)}`);
  }
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

export function bandPath(b, top, bottom, { color = C.drawn, opacity = 0.16, steps = 240 } = {}) {
  const up = [];
  const down = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    up.push(`${b.sx(u).toFixed(1)},${b.sy(top(u)).toFixed(1)}`);
    down.unshift(`${b.sx(u).toFixed(1)},${b.sy(bottom(u)).toFixed(1)}`);
  }
  return `<polygon points="${[...up, ...down].join(' ')}" fill="${color}" opacity="${opacity}"/>`;
}

/** An area under a curve, standing on the box floor. */
export function areaPath(b, f, { color = C.drawn, opacity = 0.18, steps = 240 } = {}) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    pts.push(`${b.sx(u).toFixed(1)},${b.sy(f(u)).toFixed(1)}`);
  }
  return `<polygon points="${b.x},${b.y + b.h} ${pts.join(' ')} ${b.x + b.w},${b.y + b.h}" fill="${color}" opacity="${opacity}"/>`;
}

/** Values as dots: item i of n sits at u = i/(n−1). */
export function dots(b, values, { color = C.made, r = 2.4, opacity = 0.85 } = {}) {
  const n = values.length;
  return values
    .map((v, i) => {
      const u = n > 1 ? i / (n - 1) : 0.5;
      return `<circle cx="${b.sx(u).toFixed(1)}" cy="${b.sy(v).toFixed(1)}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
    })
    .join('');
}

/** A histogram of `values` over the box's horizontal span. */
export function histogram(b, values, { buckets = 25, lo = 0, hi = 100, color = C.made } = {}) {
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    const k = Math.floor(((v - lo) / (hi - lo)) * buckets);
    counts[Math.min(buckets - 1, Math.max(0, k))] += 1;
  }
  const peak = Math.max(...counts, 1);
  const bw = b.w / buckets;
  return counts
    .map((c, i) => {
      const h = (c / peak) * b.h;
      return `<rect x="${(b.x + i * bw + 0.6).toFixed(1)}" y="${(b.y + b.h - h).toFixed(1)}" width="${(bw - 1.2).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.75"/>`;
    })
    .join('');
}

// ---------------------------------------------------------------- PNG writer

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit RGBA PNG, no interlacing, filter None on every row. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width * 4; x++) raw[p++] = rgba[y * width * 4 + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------- running the engine

/**
 * Generate one column of values with the real CLI, so a figure always shows what
 * the engine does rather than what the author believes it does.
 */
export function makeRunner(cli, tag) {
  const tmp = join(tmpdir(), `tdc-figures-${tag}.tdc`);
  return (config) => {
    writeFileSync(tmp, config);
    return execFileSync('node', [cli, tmp], { encoding: 'utf8' })
      .split('\n')
      .filter((s) => s.trim() !== '');
  };
}

/** A one-sequence config whose only output is that sequence, one value per row. */
export const oneColumn = (gen, count, seed = 'doc') =>
  `<tdc><env count="${count}" seed="${seed}"><sequence name="V">${gen}</sequence></env>` +
  `<block><line><data>\${{V}}</data></line></block></tdc>`;
