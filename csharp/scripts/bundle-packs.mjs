#!/usr/bin/env node
/**
 * Put the starter data packs inside the assembly, just long enough to build it.
 *
 * A NuGet package is a zip with an assembly in it and nothing above it. The C#
 * implementation finds packs by looking beside the assembly and then walking up
 * for `data/packs`, which works in a checkout and cannot work in
 * `~/.nuget/packages` — so a package published as-is throws
 * `no data packs found` on the first `type="template"`. Verified by installing
 * the package into a project outside the repository and running one.
 *
 * The packs live once, at the repository root, shared by all five
 * implementations. So they are copied in before packing and removed after,
 * exactly as `typescript/scripts/bundle-packs.mjs` does for npm — a stale
 * duplicate left behind inside the project would shadow the real one and be
 * silently out of date.
 *
 *   node scripts/bundle-packs.mjs add      # before `dotnet pack`
 *   node scripts/bundle-packs.mjs remove   # after
 *
 * The .csproj globs whatever is here as `EmbeddedResource`, so the data ends up
 * INSIDE the .dll rather than beside it. That is the only shape that survives
 * every way a consumer can build: a plain library reference, a single-file
 * publish, a trimmed one.
 */

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', '..', 'data', 'packs');
const target = resolve(here, '..', 'Tdcv2', 'PacksData');

/**
 * What ships inside the package: enough to run the documentation's first example
 * and nothing more. Everything else is a download away — `tdcv2 pack add ru
 * france` — from the registry every implementation reads.
 *
 * The same three npm, the wheel, the jar and the crate carry, deliberately: an
 * install that behaves differently depending on which ecosystem it came from is
 * the bug the shared fixtures exist to prevent, and it would be worst in the
 * very first minute of someone's first try.
 */
const STARTER = ['common', 'en', 'countries/usa'];

const mode = process.argv[2];

if (mode === 'add') {
  const staging = `${target}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const pack of STARTER) {
    const from = join(source, ...pack.split('/'));
    if (!existsSync(from)) {
      console.error(`bundle-packs: ${pack} is not in ${source}`);
      process.exit(1);
    }
    cpSync(from, join(staging, ...pack.split('/')), { recursive: true });
  }
  // Built beside, then renamed: a concurrent build must never see it half full.
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  console.log(`bundle-packs: staged ${STARTER.join(', ')} for embedding`);
} else if (mode === 'remove') {
  if (existsSync(target)) {
    const doomed = `${target}.removing`;
    rmSync(doomed, { recursive: true, force: true });
    renameSync(target, doomed);
    rmSync(doomed, { recursive: true, force: true });
  }
  console.log('bundle-packs: removed the temporary copy');
} else {
  console.error('usage: bundle-packs.mjs add|remove');
  process.exit(2);
}
