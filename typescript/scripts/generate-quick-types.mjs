/**
 * Write the address tree of the quick API as TypeScript types.
 *
 * `tdc.person.male.firstName()` is only worth anything if the editor completes
 * it and a typo is a compile error. An index signature cannot do either — it
 * accepts every name and, under this repo's strict settings, returns
 * `undefined` for all of them. So the 3957 bundled addresses become real
 * properties, generated from the same registry the engine reads.
 *
 * The root is kept SMALL on purpose. Dumping 122 locale and country codes next
 * to 58 data categories made the completion list a wall of names with no shape
 * — `algeria`, `angola`, `ar`, `argentina` … sitting beside `person` and
 * `work`. So the codes moved one level down, under the word that says what they
 * are:
 *
 *   tdc.person.lastName()          relative to the active locale
 *   tdc.lang.ru.person.lastName()  a named language pack
 *   tdc.country.usa.docs.ssn()     a named country pack
 *   tdc.common.internet.email()    the locale-agnostic bucket
 *
 * The relative view is the UNION over locale packs: `person.lastName` exists
 * because some locale has it. A locale that lacks the address fails at the
 * call, not at compile time — the alternative is a different type per locale,
 * which no editor could help with.
 *
 *   node scripts/generate-quick-types.mjs           # write
 *   node scripts/generate-quick-types.mjs --check   # fail if stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPacksDir, scanPacks } from '../dist/data-pack/index.js';
import { CANONICAL_LOCALES, RESERVED_BUCKETS } from '../dist/data-pack/locales.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../src/quick/addresses.ts');

/**
 * A property name for the type. Pack segments are mostly plain identifiers, but
 * some carry spaces and apostrophes — `Asie de l'Est` — so anything that is not
 * an identifier is quoted and escaped.
 */
const bare = (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
const key = (name) =>
  bare(name) ? name : `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Marks a node whose own path is a real address.
 *
 * A branch is not automatically callable: `common.device` only exists to hold
 * `common.device.imei`, and calling it used to compile and then throw at
 * runtime — the exact opposite of what generating these types is for. A symbol
 * keeps the flag out of `Object.keys`, so it can never collide with a segment.
 */
const IS_ADDRESS = Symbol('address');

function insert(tree, segments) {
  let node = tree;
  for (const segment of segments) {
    node = node[segment] ?? (node[segment] = {});
  }
  node[IS_ADDRESS] = true;
}

/**
 * Names a callable type already carries from `Function`.
 *
 * `company.name` is a real address, but intersecting a node with a callable
 * interface makes its `name` the intersection of `Function.name` (a string) and
 * the address — which is not callable, so the call fails to compile. Thirty
 * bundled addresses end in `name`. A node holding one of these is written with
 * its call signature inline instead, where an explicit member wins outright.
 */
const FUNCTION_MEMBERS = new Set([
  'name',
  'length',
  'call',
  'apply',
  'bind',
  'caller',
  'arguments',
  'prototype',
  'toString',
  'constructor',
  'valueOf',
]);

/**
 * Render one node: what hangs off it, and a call signature only if its own path
 * is an address someone can draw from.
 */
function render(node, indent) {
  const pad = ' '.repeat(indent);
  const names = Object.keys(node).sort();
  const callable = node[IS_ADDRESS] === true;
  if (names.length === 0) return 'QuickAddress';
  const body = names
    .map((name) => `${pad}  readonly ${key(name)}: ${render(node[name], indent + 2)};`)
    .join('\n');
  if (!callable) return `{\n${body}\n${pad}}`;
  if (!names.some((name) => FUNCTION_MEMBERS.has(name))) {
    return `QuickAddress & {\n${body}\n${pad}}`;
  }
  return (
    `{\n${pad}  (params?: QuickParams): string;\n` +
    `${pad}  many: (count: number, params?: QuickParams) => string[];\n` +
    `${body}\n${pad}}`
  );
}

const dir = bundledPacksDir();
const registry = scanPacks(dir === undefined ? [] : [dir]).registry;

const lang = {};
const country = {};
const buckets = {};
const relative = {};
for (const address of registry.keys()) {
  const segments = address.split('.');
  const [head, ...rest] = segments;
  if (CANONICAL_LOCALES.has(head)) {
    insert(lang, segments);
    // A language pack's address is also reachable without its code, against
    // whatever locale is active — the same rule a config follows.
    if (rest.length > 0) insert(relative, rest);
  } else if (RESERVED_BUCKETS.has(head)) {
    insert(buckets, segments);
  } else {
    insert(country, segments);
  }
}

const merged = { ...relative, ...buckets, lang, country };

const generated =
  `/**\n` +
  ` * GENERATED by scripts/generate-quick-types.mjs — do not edit.\n` +
  ` *\n` +
  ` * Every bundled address, as a property. Regenerate after changing the packs:\n` +
  ` * \`npm run quick:types\`. \`npm run check\` fails if the two disagree.\n` +
  ` *\n` +
  ` * ${String(registry.size)} addresses.\n` +
  ` */\n\n` +
  `import type { QuickAddress, QuickParams } from './types.js';\n\n` +
  `export type QuickAddressTree = ${render(merged, 0)};\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== generated) {
    console.error(
      'src/quick/addresses.ts is out of date — run `npm run quick:types` and commit the result',
    );
    process.exit(1);
  }
  console.log(`quick API types match the packs (${String(registry.size)} addresses)`);
} else {
  writeFileSync(OUT, generated);
  console.log(`wrote ${String(registry.size)} addresses to ${join('src', 'quick', 'addresses.ts')}`);
}
