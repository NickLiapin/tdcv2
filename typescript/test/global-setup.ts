/**
 * One build, before any worker starts.
 *
 * Three test files spawn the compiled CLI (`dist/cli/main.js`) and its worker,
 * so each of them used to run `npm run build` in its own `beforeAll`. Vitest
 * runs test FILES in parallel workers, so those builds overlapped: `tsc`
 * rewrites `dist/cli/main.js` in place, and a sibling that spawned `node
 * dist/cli/main.js` during that window died instantly with a module error.
 *
 * The symptom was a test that failed in 199 ms — a tenth of the time the real
 * work takes — and passed on its own every time it was re-run, which is the
 * signature of a race rather than a regression.
 *
 * `globalSetup` runs once per vitest invocation, in the main process, before
 * any worker exists. Nothing else may build.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'ignore' });
}
