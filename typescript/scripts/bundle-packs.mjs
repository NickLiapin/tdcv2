/**
 * Copy the data packs into the package just long enough to build the tarball.
 *
 * `files` in package.json cannot reach outside the package directory, so the
 * packs — which live at the repo root and are shared with the future Python and
 * Java ports — have to be duplicated in before `npm pack` runs and removed
 * again after. Leaving the copy behind would be worse than not having it: a
 * stale duplicate inside `typescript/data` shadows the real one and would be
 * silently out of date.
 *
 * Both directions swap the directory ATOMICALLY (build beside it, then
 * rename). The copy lands on the very path the runtime probes first, so a test
 * running concurrently must never be able to observe it half-populated or
 * half-deleted — which showed up as a roughly one-in-five flaky suite.
 *
 * Run automatically by the `prepack` / `postpack` lifecycle scripts.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', '..', 'data', 'packs');
const target = resolve(here, '..', 'data', 'packs');

/**
 * What ships inside the package: enough to run the documentation's first
 * example and nothing more. Everything else is a download away —
 * `tdcv2 pack add ru france` — from the registry every implementation reads.
 *
 * The same three the Java jar bundles, deliberately: an install that behaves
 * differently depending on which ecosystem it came from is the bug the shared
 * fixtures exist to prevent, and it would be worst in the very first minute of
 * someone's first try. All the packs together are 16 MB; these are 2.
 */
const STARTER = ['common', 'en', 'countries/usa'];

const mode = process.argv[2];

if (mode === 'add') {
  if (!existsSync(source)) {
    console.error(`bundle-packs: no packs at ${source}`);
    process.exit(1);
  }
  const staging = resolve(here, '..', '.packs-staging');
  rmSync(staging, { recursive: true, force: true });
  for (const set of STARTER) {
    const from = join(source, set);
    if (!existsSync(from)) {
      console.error(`bundle-packs: the starter set "${set}" is missing from ${source}`);
      process.exit(1);
    }
    cpSync(from, join(staging, set), { recursive: true });
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(resolve(target, '..'), { recursive: true });
  renameSync(staging, target); // atomic: the path appears fully formed
  console.error(`bundle-packs: copied ${STARTER.join(', ')} into ${target}`);
} else if (mode === 'remove') {
  const data = resolve(here, '..', 'data');
  const doomed = resolve(here, '..', '.packs-removing');
  rmSync(doomed, { recursive: true, force: true });
  if (existsSync(data)) renameSync(data, doomed); // atomic: it vanishes at once
  rmSync(doomed, { recursive: true, force: true });
  console.error('bundle-packs: removed the temporary copy');
} else {
  console.error('usage: bundle-packs.mjs add|remove');
  process.exit(1);
}
