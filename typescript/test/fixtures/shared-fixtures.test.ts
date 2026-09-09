/**
 * The reference, held to the same shared fixtures as the four ports — inside the same instrument.
 *
 * These files were already checked, by three standalone scripts in `npm run check`. What they
 * were not was MEASURED: the scripts run outside vitest, so none of the code they exercise
 * counted towards coverage. The number that came out was a statement about the unit tests alone,
 * while every port's number included its fixture suites, because the ports read these same files
 * from inside their own test runners.
 *
 * That gap was not cosmetic. `sequence/composed.ts` read 26% while being run end to end; and
 * adding engine code to the reference made its coverage FALL until a unit test was written to
 * compensate — twice in one day. A floor that punishes engine work is measuring the wrong thing.
 *
 * The scripts keep `--update`: writing `expected` is the reference's privilege and belongs in one
 * obvious place. They no longer keep their own copy of how a case is RUN — that lives in
 * `scripts/shared-fixtures.mjs`, which this file imports, so the suite and the gate cannot drift
 * apart on the one function whose whole job is that nothing drifts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CASES_DIR,
  DIAGNOSTICS_DIR,
  ENGINES,
  SHARED_DIR,
  diagnoseCase,
  fromLines,
  readFixtureFiles,
  renderCase,
  toLines,
} from '../../scripts/shared-fixtures.js';

interface Case {
  readonly name: string;
  readonly config: string;
  readonly expected?: readonly string[];
  readonly dataPath?: string;
}

const caseFiles = readFixtureFiles(CASES_DIR) as { file: string; doc: { cases: Case[] } }[];
const diagnosticFiles = readFixtureFiles(DIAGNOSTICS_DIR) as {
  file: string;
  doc: { cases: Case[] };
}[];

describe('the shared rendering cases', () => {
  for (const { file, doc } of caseFiles) {
    it(`${file}: every case renders what the fixture says`, () => {
      for (const testCase of doc.cases) {
        expect(fromLines(testCase.expected ?? []), `${file} / ${testCase.name}`).toBe(
          renderCase(testCase),
        );
      }
    });
  }
});

describe('the shared diagnostic cases', () => {
  for (const { file, doc } of diagnosticFiles) {
    it(`${file}: every case reports the same codes, at the same places`, () => {
      for (const testCase of doc.cases) {
        expect(
          diagnoseCase(testCase.config, testCase.dataPath),
          `${file} / ${testCase.name}`,
        ).toEqual(testCase.expected ?? []);
      }
    });
  }
});

interface EngineEntry {
  readonly lines?: readonly string[];
  readonly refused?: string;
}

const engines = JSON.parse(readFileSync(join(SHARED_DIR, 'engines.json'), 'utf8')) as {
  cases: Record<string, Record<string, EngineEntry>>;
};

describe('the same cases on the streaming engines', () => {
  for (const engine of ENGINES) {
    it(`engine ${String(engine)}: renders or refuses exactly as recorded`, () => {
      for (const { file, doc } of caseFiles) {
        for (const testCase of doc.cases) {
          const key = `${file.replace(/\.json$/, '')}/${testCase.name}`;
          const entry = engines.cases[key]?.[`engine${String(engine)}`];
          expect(entry, `${key} is missing from engines.json`).toBeDefined();
          let produced: string[] | undefined;
          let refusal: string | undefined;
          try {
            produced = toLines(renderCase(testCase, engine));
          } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
          }
          if (entry?.refused !== undefined) {
            // WHAT is refused is the contract; the wording is not — the ports phrase their own.
            expect(refusal, `${key} should have been refused, and rendered instead`).toBeDefined();
          } else {
            expect(refusal, `${key} was refused: ${refusal ?? ''}`).toBeUndefined();
            expect(produced, key).toEqual(entry?.lines);
          }
        }
      }
    });
  }
});
