/**
 * Regenerate `fixtures/cross-language/filter-vectors.json` from the reference implementation.
 *
 * The formatting layer is small and full of decisions a port can get subtly wrong: which end a
 * mask index counts from, whether a range may run backwards, whether an unknown filter throws or
 * passes the value through. Pinning the answers as data lets every implementation be asked the
 * same questions instead of each being argued with separately.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyFilter } from '../dist/format/transforms.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../fixtures/cross-language/filter-vectors.json');

/** [filter, argument, input] — the argument is empty where the filter takes none. */
const CASES = [
  ['mask', 'xxx-xxx', '1234567'],
  ['mask', 'w[1] w[0]', 'John Smith'],
  ['mask', 'w[0] *', 'John Ronald Reuel Tolkien'],
  ['mask', 'x[0]. *', 'John Smith'],
  ['mask', '[tel.] xxx', '123'],
  ['mask', 'x[-1]', 'abcdef'],
  ['mask', 'x[1..3]', 'abcdef'],
  ['mask', 'x[3..1]', 'abcdef'],
  ['mask', 'x[9]', 'abc'],
  ['mask', '\\x xx', 'abc'],
  ['mask', 'w[-1], w[0]', 'Ann Bee Cee'],
  ['upper', '', 'straße'],
  ['lower', '', 'ÄÖÜ'],
  ['capitalize', '', 'мир труд'],
  ['title', '', 'mcDonald and sons'],
  ['slice', '1,4', 'abcdefg'],
  ['slice', '2', 'abcdefg'],
  ['slice', '-3', 'abcdefg'],
  ['replace', 'a,X', 'banana'],
  ['trim', '', '  padded  '],
  ['group', '3,-', '1234567'],
  ['group', '4, ', '1234567890'],
  ['compact', '', '1000000'],
  ['compact', '16', '255'],
  ['compact', '', 'not a number'],
  ['csv', '', 'Knife set, 3 "pcs"'],
  ['sql', '', "O'Brien"],
  ['nosuchfilter', '', 'left alone'],
];

const vectors = CASES.map(([kind, arg, input]) => ({
  kind,
  arg,
  input,
  expected: applyFilter(kind, arg === '' ? undefined : arg, input),
}));

const document = {
  schemaVersion: 1,
  $comment:
    'Interpolation filters and positional masks, as the TypeScript reference computes them. ' +
    'Regenerate with `npm run fixtures:filters`. The formatting layer is shared by three ' +
    'places that mean the same thing — the case= attribute, the compute tags and the ' +
    '${{Name|filter}} syntax — so one of these drifting shows up in all of them.',
  vectors,
};

writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
console.error(`wrote ${OUT} (${String(vectors.length)} vectors)`);
