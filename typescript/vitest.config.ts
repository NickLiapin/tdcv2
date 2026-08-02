import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
        // LSP server is thin I/O glue, exercised by real editors, not units.
        '**/lsp/server.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        // Enforced only once Phase 2+ code lands; initial scaffold has 100%
        // coverage trivially. Kept as floor to be raised as code grows.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    reporters: ['default'],
    testTimeout: 10_000,
  },
});
