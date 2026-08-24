import { defineConfig } from 'vitest/config';

/**
 * The heavy tests: real files of gigabyte scale, local only.
 *
 * A separate config rather than a flag, because the protection has to be
 * structural. The default `vitest.config.ts` includes `test/**\/*.test.ts`
 * and these are `*.heavy.ts`, so an ordinary run — and therefore CI — cannot
 * reach them even by accident. Each file also refuses to start when `CI` is
 * set, so a mistaken workflow line fails in a second instead of burning an
 * hour of Actions budget on a 10 GB write.
 *
 * See test/heavy/README.md for what each one proves and what it costs.
 */
export default defineConfig({
  test: {
    include: ['test/heavy/**/*.heavy.ts'],
    globalSetup: ['test/global-setup.ts'],
    // One at a time: these are disk- and memory-bound, and two at once would
    // measure the contention rather than the engine.
    fileParallelism: false,
    testTimeout: 45 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
  },
});
