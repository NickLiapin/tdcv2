/**
 * Build the downloadable data-pack bundles from the monorepo's `data/`.
 *
 * The CDN repo (tdcv2-data-packs) is a BUILD ARTIFACT, never hand-edited: this
 * script is the single source of the zips and their index.json. It reads the
 * bundle manifest (`data/bundles.json`), zips each bundle's pack subtree, and
 * writes an index whose `bytes`/`sha256` are COMPUTED from the zips it just
 * wrote — so the hashes can never disagree with the files.
 *
 * Bundles are axis-pure by design (one language, or one country, or `common`),
 * because language and country are independent dimensions that compose. A
 * bundle's zip mirrors the layout the `pack` command expects — `<id>/packs/…` —
 * so `pack add` registers `<store>/<id>/packs` and addresses resolve unchanged
 * (`common.book.isbn10`, `en.person.lastName`, `usa.docs.ssn`).
 *
 *   node scripts/build-data-packs.mjs [--out <dir>]   # default: build/data-packs
 *
 * Output is deterministic (fixed entry mtime, sorted entries) so re-running
 * without a data change produces byte-identical zips and the same hashes.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const DATA = join(REPO, 'data');
const MANIFEST = join(DATA, 'bundles.json');

// A fixed timestamp so the zip bytes (and thus the sha256) depend only on the
// data, not on when the build ran.
const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');

const outArgIndex = process.argv.indexOf('--out');
const OUT =
  outArgIndex !== -1 ? resolve(process.argv[outArgIndex + 1]) : join(REPO, 'build/data-packs');

/** Every file under `dir`, recursively, skipping dotfiles like `.DS_Store`. */
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .DS_Store and friends
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function readManifest() {
  const raw = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(raw.bundles)) throw new Error('bundles.json: "bundles" must be an array');
  return raw.bundles;
}

/**
 * Build one bundle's zip. Entry paths are `<id>/<path-relative-to-data>`, e.g.
 * `common/packs/common/book/isbn10.txt`, so an extract to `<store>/<id>/` lands
 * the pack root at `<store>/<id>/packs`.
 */
function buildZip(bundle) {
  const files = {};
  for (const packPath of bundle.packs) {
    const abs = join(DATA, packPath);
    if (!existsSync(abs))
      throw new Error(`bundle "${bundle.id}": missing "${packPath}" under data/`);
    for (const file of walkFiles(abs)) {
      const entry = `${bundle.id}/${relative(DATA, file).split('\\').join('/')}`;
      files[entry] = [new Uint8Array(readFileSync(file)), { mtime: FIXED_MTIME }];
    }
  }
  // Sort entries so the archive is deterministic regardless of readdir order.
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return zipSync(sorted, { level: 9 });
}

function main() {
  const bundles = readManifest();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'bundles'), { recursive: true });

  const indexBundles = [];
  for (const bundle of bundles) {
    const zip = buildZip(bundle);
    const file = `bundles/${bundle.id}.zip`;
    writeFileSync(join(OUT, file), zip);
    const sha256 = createHash('sha256').update(zip).digest('hex');
    const entry = {
      id: bundle.id,
      name: bundle.name,
      description: bundle.description,
      file,
      bytes: zip.length,
      sha256,
    };
    if (bundle.locale !== undefined) entry.locale = bundle.locale;
    if (bundle.country !== undefined) entry.country = bundle.country;
    // Where the country is. Carried in the index so every implementation's picker can group and
    // plot it without keeping a copy of world geography of its own.
    if (bundle.regions !== undefined) entry.regions = bundle.regions;
    if (bundle.point !== undefined) entry.point = bundle.point;
    entry.contents = bundle.packs;
    indexBundles.push(entry);
    console.error(`built ${file}: ${String(zip.length)} bytes, sha256 ${sha256.slice(0, 12)}…`);
  }

  const index = {
    schemaVersion: 1,
    description:
      'TDC data packs. Axis-pure bundles that compose: install common + a language (en, …) + a country (usa, …). Verify each by sha256.',
    bundles: indexBundles,
  };
  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.error(`wrote ${join(OUT, 'index.json')} (${String(indexBundles.length)} bundles)`);
}

main();
