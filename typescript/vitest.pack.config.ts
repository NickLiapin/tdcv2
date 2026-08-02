import { defineConfig } from 'vitest/config';

/**
 * The packaging smoke test, run on its own.
 *
 * It calls `npm pack`, whose prepack step copies the data packs into
 * `typescript/data/packs` and whose postpack removes them. `bundledPacksDir()`
 * probes exactly that path first, so any other test spawning the CLI during
 * that window dies with "cannot read data-pack file". Running it alongside the
 * rest produced a failure that looked like resource exhaustion — and stayed
 * misdiagnosed for an evening because the child's stderr was discarded.
 *
 * Hence its own config rather than a flag: `--exclude` on the CLI appends to
 * the main config's list instead of replacing it, so the file would exclude
 * itself.
 */
export default defineConfig({
  test: {
    include: ['test/cli/install-smoke.test.ts'],
  },
});
