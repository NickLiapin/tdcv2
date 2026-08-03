/**
 * Every name the engine implements, read out of the engine itself.
 *
 * Generator types, interpolation filters, compute tags, diagnostic codes, date
 * tokens, distributions, encodings, attributes. The reference is the source: a
 * hand-kept list would be one more thing to forget to update, which is the
 * failure every audit built on top of this exists to catch.
 *
 * Two audits read this and ask different questions of the same list —
 * `webdoc/scripts/audit-doc-coverage.mjs` asks whether each name is DOCUMENTED,
 * `scripts/audit-fixture-coverage.mjs` whether each is EXERCISED by a shared
 * cross-language case. Sharing the enumeration is what stops the two disagreeing
 * about what the engine even has.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'typescript', 'src');

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

const srcText = walk(SRC, '.ts')
  .filter((f) => !f.includes('generated'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** Every name captured by `re` (group 1) across the engine sources. */
export function fromEngine(re) {
  return [...new Set([...srcText.matchAll(re)].map((m) => m[1]))].sort();
}

/** Members of an exported string-literal array, e.g. `export const X = ['a','b']`. */
function listOf(constName) {
  const decl = new RegExp(`export const ${constName}[^;]*`, 's').exec(srcText)?.[0] ?? '';
  return [...new Set((decl.match(/'([a-zA-Z0-9_]+)'/g) ?? []).map((s) => s.slice(1, -1)))];
}

/**
 * `case 'x':` labels inside one engine file, optionally narrowed to a single
 * exported function.
 *
 * The narrowing is not cosmetic. The doc audit first reported `char` and `lit` as
 * undocumented filters the day transforms.ts grew a second switch — one over the
 * slots of a parsed mask, which has nothing to do with filter names. Scraping a
 * whole file for `case` labels assumes the file has exactly one switch and will
 * keep having one, which is not an assumption a checker gets to make.
 */
function casesOf(relPath, withinFns) {
  const file = join(SRC, relPath);
  const whole = readFileSync(file, 'utf8');
  const sources =
    withinFns === undefined
      ? [whole]
      : withinFns.map((fn) => {
          const start = whole.indexOf(`function ${fn}`);
          if (start === -1) throw new Error(`audit: ${fn} not found in ${relPath}`);
          const end = whole.indexOf('\n}', start); // the line that closes it
          return whole.slice(start, end === -1 ? undefined : end);
        });
  const names = sources.flatMap((text) =>
    (text.match(/case '([a-z_0-9]+)'/g) ?? []).map((s) => s.slice(6, -1)),
  );
  return [...new Set(names)].sort();
}

/** Tokens the date formatter understands, taken from its own token table. */
function dateTokens() {
  const text = readFileSync(join(SRC, 'date', 'format.ts'), 'utf8');
  return [...new Set((text.match(/'([A-Za-z]{1,4})'/g) ?? []).map((s) => s.slice(1, -1)))]
    .filter((t) => /^[A-Za-z]+$/.test(t))
    .sort();
}

/** Every attribute the engine reads by name out of a config. */
export function engineAttributes() {
  return fromEngine(/attr(?:s|Map)\[\s*'([a-z_][a-z_0-9]*)'\s*\]/g);
}

/** The surface, grouped the way a report should read it. */
export function groups() {
  return [
    { id: 'gen', title: 'generator types', names: listOf('KNOWN_GEN_TYPES') },
    {
      id: 'filter',
      title: 'interpolation filters',
      names: casesOf('format/transforms.ts', ['applyFilter']),
    },
    {
      id: 'compute',
      title: 'compute tags',
      names: casesOf('compute/evaluate.ts', ['evalElement', 'evalPredicate']),
    },
    { id: 'code', title: 'diagnostic codes', names: fromEngine(/code:\s*'(TDC\d{3})'/g) },
    { id: 'date', title: 'date format tokens', names: dateTokens() },
    { id: 'dist', title: 'distributions', names: casesOf('generators/distribution.ts') },
    { id: 'enc', title: 'encodings', names: listOf('ENCODINGS') },
  ];
}
