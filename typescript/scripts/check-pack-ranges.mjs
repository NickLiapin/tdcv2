#!/usr/bin/env node
/**
 * A numeric range must not be written as a regex alternation.
 *
 * `type="regex"` picks an alternation's branches with EQUAL probability — that is
 * documented and deliberate, and it is exactly what makes `(?:000[1-9]|00[1-9][0-9]|
 * 0[1-9][0-9]{2}|[1-9][0-9]{3})` a bug when it is meant to say "0001-9999": four
 * branches holding 9, 90, 900 and 9000 values each take a quarter of the draws, so
 * three quarters of the results start with a zero instead of one in ten. The pool
 * looks like ten thousand values and behaves like a few hundred, and the first
 * symptom is duplicates in a column nobody expected to collide.
 *
 * `<gen type="number" value="lo..hi" length="W" first_zero="true"/>` says the same
 * thing and draws evenly. This check finds the alternations that should be one.
 *
 * A list of unrelated fixed codes — `(?:978|979)`, card BINs, country prefixes — is
 * NOT a range and is left alone: those branches are meant to be equally likely.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACKS = resolve(here, '..', '..', 'data', 'packs');

/** Every string a digits-only branch can produce, or undefined if it is not one. */
function expand(branch, cap = 50_000) {
  let out = [''];
  let i = 0;
  while (i < branch.length) {
    let chars;
    const c = branch[i];
    if (c === '[') {
      const j = branch.indexOf(']', i);
      if (j < 0) return undefined;
      chars = [];
      const cls = branch.slice(i + 1, j);
      for (let k = 0; k < cls.length; ) {
        if (cls[k + 1] === '-' && k + 2 < cls.length) {
          for (let x = cls.charCodeAt(k); x <= cls.charCodeAt(k + 2); x++) {
            chars.push(String.fromCharCode(x));
          }
          k += 3;
        } else {
          chars.push(cls[k] ?? '');
          k += 1;
        }
      }
      if (!chars.every((ch) => ch >= '0' && ch <= '9')) return undefined;
      i = j + 1;
    } else if (c !== undefined && c >= '0' && c <= '9') {
      chars = [c];
      i += 1;
    } else {
      return undefined;
    }
    let repeat = 1;
    if (branch[i] === '{') {
      const j = branch.indexOf('}', i);
      const body = branch.slice(i + 1, j);
      if (body.includes(',')) return undefined;
      repeat = Number(body);
      i = j + 1;
    }
    if (branch[i] === '?') return undefined;
    for (let r = 0; r < repeat; r++) {
      if (out.length * chars.length > cap) return undefined;
      out = out.flatMap((p) => chars.map((ch) => p + ch));
    }
  }
  return out;
}

/** `{ lo, hi, width, missing }` when the alternation spells a numeric range, else undefined. */
function asRange(body) {
  const sets = body.split('|').map((b) => expand(b));
  if (sets.some((s) => s === undefined)) return undefined;
  const values = sets.flat();
  const width = values[0]?.length ?? 0;
  if (!values.every((v) => v.length === width)) return undefined;
  const nums = values.map(Number).sort((a, b) => a - b);
  if (new Set(nums).size !== nums.length) return undefined;
  const lo = nums[0] ?? 0;
  const hi = nums[nums.length - 1] ?? 0;
  const present = new Set(nums);
  const missing = [];
  for (let n = lo; n <= hi; n++) if (!present.has(n)) missing.push(n);
  // Many gaps means these are unrelated codes, not a range with exclusions.
  if (missing.length > 5) return undefined;
  const sizes = sets.map((s) => s?.length ?? 0);
  // Branches of equal size are already drawn evenly — nothing to fix.
  if (Math.max(...sizes) === Math.min(...sizes)) return undefined;
  return { lo, hi, width, missing };
}

/**
 * Every file the pack loader reads — which is every file that is not a dotfile, a locale's
 * `_locale.json`, or prose.
 *
 * Not a list of extensions. `.txt` was never what made a file a pack; it was only what the packs
 * happened to be when this was written, and the sixteen composed `.tdc` packs sat outside the check
 * entirely until this stopped naming an extension. A generator inside a `.tdc` can write a range as
 * an alternation exactly as one inside a `.txt` can.
 */
function isPackFile(name) {
  if (name.startsWith('.') || name === '_locale.json') return false;
  const base = name.toLowerCase().replace(/\.[^.]+$/, '');
  return base !== 'readme' && base !== 'license' && base !== 'changelog';
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (isPackFile(entry)) out.push(path);
  }
  return out;
}

const findings = [];
for (const file of walk(PACKS)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/type="regex" value="([^"]*)"/g)) {
    for (const alt of (m[1] ?? '').matchAll(/\(\?:([^()]*\|[^()]*)\)/g)) {
      const range = asRange(alt[1] ?? '');
      if (range === undefined) continue;
      const pad = range.lo.toString().length < range.width;
      const attrs =
        `value="${range.lo}..${range.hi}"` +
        (pad ? ` length="${range.width}" first_zero="true"` : '') +
        (range.missing.length > 0 ? ` exclude="${range.missing.join(',')}"` : '');
      findings.push({ file: file.slice(PACKS.length + 1), alt: alt[1] ?? '', attrs });
    }
  }
}

for (const f of findings) {
  console.log(`\n${f.file}`);
  console.log(`  (?:${f.alt})`);
  console.log(`  → <gen type="number" ${f.attrs}/>`);
}
console.log(
  findings.length === 0
    ? `\nno pack writes a numeric range as an alternation`
    : `\n${String(findings.length)} numeric range(s) written as an alternation — see above`,
);
process.exit(findings.length > 0 ? 1 : 0);
