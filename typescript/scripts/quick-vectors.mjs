#!/usr/bin/env node
/**
 * Regenerate `fixtures/cross-language/quick-vectors.json` from the reference.
 *
 * The quick API is five implementations of one contract — the same synthesised
 * config, the same 512-row batch, the same `#`-derived seed for the batch after
 * it — and nothing but a shared fixture keeps them honest about it. The values
 * here are captured from THIS implementation because TypeScript is the
 * reference; the other four read the file and must reproduce it.
 *
 * The 600-value case is the important one. Everything below 512 comes out of a
 * single underlying run, so two implementations can agree on all of it while
 * disagreeing completely about what happens when that run is exhausted — which
 * is the bug a user would hit first and report last.
 *
 *   npm run fixtures:quick            # rewrite the fixture
 *   npm run fixtures:quick -- --check # fail if it would change
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BATCH_ROWS, QuickDraw } from '../dist/quick/draw.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = join(ROOT, 'fixtures', 'cross-language', 'quick-vectors.json');

const ADDRESSES = [
  { seed: 'demo', locale: 'en', address: 'person.lastName', count: 5 },
  { seed: 'demo', locale: 'en', address: 'person.male.firstName', count: 3 },
  { seed: 'demo', locale: 'en', address: 'company.industry', count: 2 },
  { seed: 'demo', locale: 'en', address: 'common.id.uuid', count: 2 },
  { seed: 'demo', locale: 'en', address: 'common.finance.iban', count: 2 },
  { seed: 'demo', locale: 'en', address: 'usa.docs.ssn', count: 3 },
  { seed: 'other', locale: 'en', address: 'person.lastName', count: 3 },
  { seed: 'l', locale: 'en', address: 'person.lastName', count: 1 },
  // Crosses the batch boundary: the one place implementations drift.
  { seed: 'batch', locale: 'en', address: 'person.lastName', count: 600 },

  // The locale, which every implementation exposes and nothing here used to pin: nine vectors
  // all said `en`, so a port that ignored the locale entirely passed the whole file.
  //
  // One address under three scripts, so a port that reaches the wrong list cannot come back with
  // something that merely looks plausible.
  { seed: 'demo', locale: 'ru', address: 'person.lastName', count: 3 },
  { seed: 'demo', locale: 'fr', address: 'person.lastName', count: 3 },
  { seed: 'demo', locale: 'ar', address: 'person.lastName', count: 3 },
  // A COMPOSED pack — `es/person/male/fullName.tdc` is a config, not a list of names — reached
  // through the quick API, where the whole config is synthesised around it.
  { seed: 'demo', locale: 'es', address: 'person.male.fullName', count: 2 },
  // An address that names its own pack outranks the locale: this must equal the `ru` vector
  // above, not the `en` list.
  { seed: 'demo', locale: 'en', address: 'ru.person.lastName', count: 2 },
  // And the other side of that rule: a country address is not a locale's to reinterpret, so this
  // must equal the first two of `demo`/`en`/`usa.docs.ssn`.
  { seed: 'demo', locale: 'ru', address: 'usa.docs.ssn', count: 2 },
];

const GENERATORS = [
  { seed: 'demo', type: 'number', attrs: { value: '18..80' }, count: 1 },
  { seed: 'x', type: 'number', attrs: { value: '1..1000' }, count: 4 },
  { seed: 'r', type: 'regex', attrs: { value: '[A-Z]{3}-[0-9]{4}' }, count: 3 },
];

/**
 * What the quick API says when it cannot draw at all.
 *
 * These are the sentences the five wrote separately and then had to be converged by hand, which
 * is the definition of something that belongs in a shared fixture. `message` is generated below,
 * never written here.
 *
 * `verbatim: false` marks the one message an implementation is allowed to word differently, and
 * says which fragments it still owes: Maven puts no `tdcv2` on the PATH, so Java's install advice
 * also names `java -jar tdcv2-cli.jar` and cannot match the reference character for character.
 * Everything else is one sentence in all five.
 */
const DIAGNOSTICS = [
  {
    name: 'a-typo-names-the-nearest-address',
    seed: 'e',
    locale: 'en',
    address: 'usa.docs.sn',
    verbatim: true,
  },
  {
    // The near miss is found against the LOCALE-QUALIFIED form too: what was typed has no locale
    // and what is proposed does.
    name: 'the-nearest-address-may-be-the-qualified-one',
    seed: 'e',
    locale: 'en',
    address: 'company.industri',
    verbatim: true,
  },
  {
    // The same shape of typo under another locale: the message names that locale, and proposes a
    // Russian address rather than an English one.
    name: 'the-locale-decides-which-near-miss-is-meant',
    seed: 'e',
    locale: 'ru',
    address: 'person.lastNam',
    verbatim: true,
  },
  {
    // Far enough away that a suggestion would be an invention. No hint at all is the contract.
    name: 'a-name-nothing-is-near-gets-no-suggestion',
    seed: 'e',
    locale: 'en',
    address: 'person.qqqqqqqqqqqqqq',
    verbatim: true,
  },
  {
    // The fork the five diverged on. A pack that is real but not downloaded must not be answered
    // with another language's address — that offers English to someone who asked for Afrikaans.
    name: 'an-uninstalled-pack-is-not-a-typo',
    seed: 'm',
    locale: 'en',
    address: 'af.person.lastName',
    verbatim: false,
    contains: [
      'the "af" pack is not installed',
      '"af.person.lastName" cannot be drawn',
      'tdcv2 pack add af',
    ],
    absent: ['Did you mean'],
  },
];

/** The message the reference raises for a draw that cannot happen. */
function refusal({ seed, locale, address }) {
  try {
    new QuickDraw(seed, locale).draw({ type: 'template', attrs: { value: address } }, 1);
  } catch (error) {
    return error.message;
  }
  throw new Error(`${address} under locale "${locale}" was expected to fail, and did not`);
}

const document = {
  schemaVersion: 1,
  $comment:
    'The quick API — one value, one call, no config — as the TypeScript reference computes ' +
    'it. Every implementation opens a run of 512 rows under the given seed, reads values from ' +
    'it in order, and reopens under the seed plus "#<batch>" when that run is exhausted; the ' +
    '600-value case is there because that boundary is the one place two implementations drift ' +
    'without anything else noticing. `addresses` carries the locale each draw runs under, and ' +
    'an address that names its own pack outranks it. `diagnostics` carries what the API says ' +
    'when it cannot draw at all: `message` is the reference wording, and where `verbatim` is ' +
    'false an implementation may word it differently but still owes every fragment in ' +
    '`contains` and none of those in `absent`. Regenerate with `npm run fixtures:quick`.',
  batchRows: BATCH_ROWS,
  addresses: ADDRESSES.map((c) => ({
    ...c,
    expected: new QuickDraw(c.seed, c.locale).draw(
      { type: 'template', attrs: { value: c.address } },
      c.count,
    ),
  })),
  generators: GENERATORS.map((g) => ({
    ...g,
    expected: new QuickDraw(g.seed, undefined).draw({ type: g.type, attrs: g.attrs }, g.count),
  })),
  diagnostics: DIAGNOSTICS.map((d) => ({ ...d, message: refusal(d) })),
};

/**
 * Written the way a commit will leave it.
 *
 * lint-staged runs prettier over the fixture, and prettier keeps a short array on
 * one line where `JSON.stringify` gives each element its own. Formatting only one
 * side means the check fails on whitespace immediately after every commit — which
 * is exactly how `quick:check` spent its life red before it was made to format
 * both sides too.
 */
function formatted(value) {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const result = spawnSync('npx', ['prettier', '--stdin-filepath', TARGET], {
    cwd: join(ROOT, 'typescript'),
    input: json,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout : json;
}

const rendered = formatted(document);

if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  // Compared as DATA as well as text: a fixture that differs only in whitespace is
  // the same contract, and saying otherwise would train everyone to ignore this.
  const sameData = JSON.stringify(JSON.parse(current)) === JSON.stringify(JSON.parse(rendered));
  if (!sameData) {
    console.error(
      'quick-vectors.json is out of date with this implementation.\n' +
        'Run `npm run fixtures:quick` and commit the result — or, if the change was ' +
        'not intended, the reference just moved and the other four will now disagree.',
    );
    process.exit(1);
  }
  console.log(
    `quick vectors match (${String(document.addresses.length)} addresses, ` +
      `${String(document.generators.length)} generators, ` +
      `${String(document.diagnostics.length)} diagnostics)`,
  );
} else {
  writeFileSync(TARGET, rendered);
  console.log(`wrote ${TARGET}`);
}
