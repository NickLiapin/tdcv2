import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * Compile once, here, before any worker starts. Three test files spawn the
     * built CLI; when each built it for itself, the concurrent `tsc` runs
     * rewrote `dist/cli/main.js` under a sibling that was spawning it.
     */
    globalSetup: ['test/global-setup.ts'],
    /**
     * The packaging smoke test runs `npm pack`, whose prepack step copies the
     * data packs to `typescript/data/packs` and whose postpack removes them
     * again. `bundledPacksDir()` probes exactly that path FIRST, so any other
     * test spawning the CLI in that window fails with "cannot read data-pack
     * file" — a race that looked like resource exhaustion for a whole evening
     * because the child's stderr was being discarded.
     *
     * Run it on its own: `npm run test:pack`. Excluding it here is a real gap
     * in the default run, which is why the script exists and CI must call both.
     */
    exclude: ['test/cli/install-smoke.test.ts', '**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/generated/**',
        '**/index.ts',
        // Type-only modules produce no runtime branches worth covering.
        '**/attrs.ts',
        '**/generator.ts',
        '**/types.ts',
        // The LSP's protocol adapter and its loader are thin I/O glue, exercised by real
        // editors rather than units. This used to name only `server.ts` — the 34-line loader —
        // so the 211-line adapter it was written for was measured after all, and read 0%. The
        // parts of it that were NOT glue moved to `pack-roots.ts`, which is measured and tested.
        '**/lsp/server.ts',
        '**/lsp/server-impl.ts',
      ],
      // `json-summary` is the one a machine reads: `scripts/coverage.mjs` puts this
      // number beside the other four implementations', which is where a branch covered
      // here and missed in a port stops being nobody's problem.
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        /*
         * A RATCHET, not a target. Each number sits just under what the suite
         * measures today, so coverage cannot slip without CI saying so — and
         * every one of them is meant to be raised, never lowered.
         *
         * `branches` was the odd one out at 70, measured 71.45, and the note
         * here said the gap was refusal paths — the arguments a generator
         * rejects. It was: writing the negative tests for the constructs added
         * since (a per-row assertion, a walked repeat, a case body that reads
         * its row, map columns) took the measurement to 75.36, and the files
         * those tests aimed at moved much further — `interpolate.ts` from 58.9
         * to 85.7 branches, `sequential.ts` from 67.6 to 86.5.
         *
         * Measured 2026-09-07: statements 86.32, branches 75.36,
         * functions 89.13, lines 88.60.
         *
         * The floor was 80 across the board from the scaffold, when the code
         * was small enough to hit it for free. It went unnoticed as the code
         * grew because this workflow was pointed at a branch that does not
         * exist and had never run.
         */
        lines: 88,
        functions: 89,
        branches: 75,
        statements: 86,
      },
    },
    reporters: ['default'],
    /**
     * Sized for a data corpus that keeps growing, not for today's count.
     *
     * Any test that scans the shipped packs gets slower every time a locale
     * ships, and under full parallel load it eventually crosses the line —
     * which reads as flakiness and is not. Two different tests hit the old
     * 10s ceiling in one day, at roughly 18,900 and 22,600 addresses. Raising
     * them one at a time just moves the failure to whichever test is next.
     */
    testTimeout: 120_000,
  },
});
