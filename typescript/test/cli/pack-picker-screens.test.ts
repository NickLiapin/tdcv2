/**
 * The pack picker's screens, against the shared fixture.
 *
 * This file exists because `src/cli/pack-picker.ts` was the least-tested file in the project by
 * a wide margin — 303 of its 354 branches reached by nothing at all — and the excuse was that it
 * needs a terminal. It does not. It needs `process.stdin`, `process.stdout` and four environment
 * variables, and `scripts/picker-screens.ts` hands it all of them, then feeds it the bytes a
 * terminal sends and reads back the lines a terminal would print.
 *
 * Nothing here is stubbed: this is `runPicker` itself, decoding real escape sequences through
 * readline and drawing real screens. What is asserted is every line of every screen after every
 * key, which is the only way a layout bug shows up as a failing test rather than as something a
 * user notices. The same file is replayed by the ports, so a screen that differs by one space in
 * one language is a failure there too.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  bundlesFromFixture,
  type FixtureBundle,
  playRun,
  type PickerRun,
} from '../../scripts/picker-screens.js';
import type { PickerResult } from '../../src/cli/pack-picker.js';

interface Fixture {
  readonly bundles: readonly FixtureBundle[];
  readonly runs: readonly (PickerRun & {
    readonly screens: readonly (readonly string[])[];
    readonly result: PickerResult | null;
  })[];
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  resolve(here, '..', '..', '..', 'fixtures', 'cross-language'),
  'pack-picker-screens.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

describe('the pack picker draws what the shared fixture says', () => {
  for (const run of fixture.runs) {
    it(
      run.name,
      async () => {
        const played = await playRun(bundlesFromFixture(fixture.bundles), run);

        // Screen by screen rather than all at once: a whole-session diff is unreadable, and the
        // key that broke it is the thing worth being told.
        expect(played.screens.length).toBe(run.screens.length);
        for (const [i, screen] of played.screens.entries()) {
          const after = i === 0 ? 'the opening draw' : `the key "${String(run.keys[i - 1])}"`;
          expect(screen.join('\n'), `after ${after}`).toBe(run.screens[i]?.join('\n'));
        }
        expect(played.result).toEqual(run.result);
      },
      20000,
    );
  }
});
