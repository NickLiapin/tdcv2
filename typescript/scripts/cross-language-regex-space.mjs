#!/usr/bin/env node
/**
 * How many different strings a `type="regex"` pattern can make, pinned across implementations.
 *
 * `uniq="true"` over a pattern refuses a count the pattern cannot meet BEFORE it draws, and it
 * knows the pattern's size by counting its parse tree. That count is new logic in five languages,
 * and it is exactly the kind that drifts quietly: whether a class `[aab]` is two characters or
 * three, whether a back-reference multiplies, what happens past 2^53. A drift here changes which
 * configs are refused, so every rule is pinned by at least one pattern below.
 *
 * Some of these are deliberately OVERCOUNTS — `(a|ab)(c|bc)` makes three strings and is counted
 * as four, a conditional counts both branches. That is the documented contract, an upper bound
 * that is exact for what identifiers are made of, and the fixture holds the five to the same
 * bound rather than to the truth.
 *
 *   --update   rewrite from current behaviour; the diff is the review.
 *   (default)  verify.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { advancedRegexSpaceSize } from '../src/generators/advanced-regex-plan.ts';
import { REGEX_SPACE_CAP, regexSpaceSize } from '../src/generators/regex.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(resolve(here, '..', '..', 'fixtures', 'cross-language'), 'regex-space.json');
const update = process.argv.includes('--update');

const PATTERNS = [
  ['[A-Z]{2}-[0-9]{4}/[0-9]{2}', 'a plate number: 26² · 10⁴ · 10²'],
  ['[0-9]{2}', 'the smallest honest space: one hundred'],
  ['[0-9]{2,3}', 'a variable length adds EVERY length it allows: 10² + 10³'],
  ['[0-9]{2,10}', 'nine lengths, eleven billion strings'],
  ['abc', 'a literal is one string'],
  ['a|b|c', 'an alternation adds its branches'],
  ['(a|ab)(c|bc)', 'OVERCOUNTED — reaches abc two ways, so four is counted for three strings'],
  ['[aab]', 'a class counts DISTINCT characters, not how often one is written'],
  ['([ab])\\1', 'a back-reference repeats a group already counted: two, not four'],
  ['(?<n>[ab])\\k<n>', 'the same by name'],
  ['(?<x>a)?(?(x)b|c)', 'OVERCOUNTED — a conditional counts both branches, though a row takes one'],
  ['x?', 'an optional is a repeat of zero or one'],
  ['a{0}', 'zero repeats is the empty string, once'],
  ['(ab){2}', 'a repeated literal stays one string'],
  ['.{2}', 'the dot is the 95 printable ASCII characters'],
  ['\\d{3}', 'a shorthand class'],
  ['\\w', 'letters, digits and the underscore'],
  ['[^a-z]', 'a negated class is printable ASCII less what it names'],
  ['[A-Za-z0-9_]{0,2}', 'the empty string counts too: 1 + 63 + 63²'],
  ['(a|a)', 'OVERCOUNTED — two branches, one string: the case the draw has to catch'],
  ['[0-9]{15}', '10¹⁵ — still exact'],
  ['[0-9]{16}', '10¹⁶ is past 2^53 − 1, so it saturates there'],
  ['[0-9]{1,32}', 'saturates part-way through the sum'],
];

/**
 * `advanced_regex` counts the same way and adds its own two constructs. A weighted choice adds its
 * branches — the WHOLE pattern's count, the first of the two checks a unique column makes; each
 * share is then counted along its own branches, which the shared cases and `cli.json` pin. A
 * conditional adds its branches plus the empty string a row matching none of them contributes,
 * unless a `*` branch leaves no such row.
 */
const ADVANCED = [
  ['(?%{70:RU;30:US})-[0-9]{3}', 'a weighted choice adds its branches: (1 + 1) · 10³'],
  ['(?%{50:(?%{50:a;50:b});50:c})[0-9]', 'nested weighted choices: (2 + 1) · 10'],
  ['((?%{50:a;50:b})){2}[0-9]', 'a weighted choice inside a repeat: 2² · 10'],
  ['(x|(?%{50:a;50:b}))[0-9]{2}', 'a weighted choice under an alternation: (1 + 2) · 10²'],
  [
    '(?<g>[ab])(?if{g=a:[cd]})',
    'a conditional with no * adds one for the row that matches nothing: 2 · (2 + 1)',
  ],
  ['(?<g>[ab])(?if{g=a:[cd];*:e})', 'with a * branch nothing falls through: 2 · (2 + 1)'],
  [
    '(?<s>(?%{50:M;50:F}))-(?if{s=M:[a-c];s=F:[x-z]})[0-9]',
    'OVERCOUNTED — both branches count although a row takes one: 2 · 7 · 10',
  ],
  ['(?%{100:(a|a)})', 'OVERCOUNTED — the case the draw has to catch'],
  ['[A-Z]{2}[0-9]{3}', 'no weighted choice at all: the same count as a plain pattern'],
  ['(?%{50:[0-9]{16};50:a})', 'saturates at 2^53 − 1 like a plain pattern'],
];

const document = {
  schemaVersion: 1,
  comment:
    'How many different strings a type="regex" pattern can make, as `uniq="true"` counts it ' +
    'before drawing. A class counts its distinct characters, a sequence multiplies, an ' +
    'alternation adds, {m,n} adds every length it allows, a back-reference counts once and a ' +
    'conditional counts both branches. `advanced` counts advanced_regex patterns the same way: a ' +
    'weighted choice adds its branches, and its conditional adds one more for a row that matches ' +
    'no branch unless a * branch catches it. Exact for literals, classes and repeats; an upper bound ' +
    `otherwise. Saturates at ${String(REGEX_SPACE_CAP)} (2^53 − 1). ` +
    'Regenerate with: npm run regex:space -- --update',
  cap: REGEX_SPACE_CAP,
  patterns: PATTERNS.map(([pattern, why]) => ({
    pattern,
    size: regexSpaceSize({ pattern }),
    why,
  })),
  advanced: ADVANCED.map(([pattern, why]) => ({
    pattern,
    size: advancedRegexSpaceSize({ pattern }),
    why,
  })),
};

if (update) {
  writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `regex-space.json: ${String(document.patterns.length)} patterns, ${String(document.advanced.length)} advanced`,
  );
  process.exit(0);
}

// Compared as DATA: the commit hook runs prettier over every fixture.
let current;
try {
  current = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  console.error(`${OUT} is missing or unreadable — run: npm run regex:space -- --update`);
  process.exit(1);
}
if (JSON.stringify(document, null, 2) !== JSON.stringify(current, null, 2)) {
  console.error(
    'The regex space count changed.\n\n' +
      'If the change is intended, run `npm run regex:space:update` and review the diff — ' +
      'every implementation is held to this file, and it decides which configs are refused.',
  );
  process.exit(1);
}
console.log(
  `regex-space.json: ${String(document.patterns.length)} patterns, ${String(document.advanced.length)} advanced match`,
);
