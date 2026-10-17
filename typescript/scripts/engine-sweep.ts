/**
 * Every config we have, on every engine, compared.
 *
 * The shared cases pin each implementation against the reference, and `engines.json`
 * pins engines 2 and 3 against the DEFAULT engine — which is not always engine 1: a
 * config the router sends to engine 2 never runs on engine 1 at all. B1 lived exactly
 * there: a `<uniq>` group with a pool lookup on one of its members was correct on
 * engines 2 and 3 and wrong on engine 1, and no case combined the two.
 *
 * This runs the reference on engines 1, 2 and 3 explicitly, over the shared cases and
 * every runnable example in the documentation, and reports where the engines that
 * produce output do not produce the same output. A refusal is not a disagreement —
 * engine 2 declines whole-column features by design — but an engine that fails an
 * `<assert>` the others pass is.
 *
 *   npx tsx scripts/engine-sweep.ts            # summary, exit 1 on any disagreement
 *   npx tsx scripts/engine-sweep.ts --verbose  # every disagreement in full
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TDC, type TdcOptions } from '../src/index.js';
import { CASES_DIR, readFixtureFiles, renderCase } from './shared-fixtures.js';
import { DOC_NOW, allExamples } from '../../scripts/doc-examples.mjs';

type Engine = NonNullable<TdcOptions['engine']>;
const ENGINES: readonly Engine[] = [1, 2, 3];

/**
 * Configs whose engines lay a column out differently, both correctly — named, not inferred,
 * so a new difference cannot hide among them. The in-memory engine settles a `<uniq>` group or
 * an exact share layout over the whole table; the disk engines repair only the rows that need
 * it. Every column keeps the multiset it drew and every tuple stays distinct either way.
 * `engines.json` pins the first four line for line; the fifth is invisible there because its
 * default engine is 2, so engine 1 is never asked.
 */
const ARRANGED_DIFFERENTLY = new Set([
  'case generators/number-length-groups-with-shares',
  'case uniq-distinct/env-uniq-across-sequences',
  'case uniq-distinct/the-block-order-is-the-order-the-subjects-appear',
  'case uniq-distinct/a-switched-mix-inside-a-uniq-group',
  'case uniq-distinct/a-plain-pack-is-laid-out-not-picked',
]);

interface Outcome {
  readonly output?: string;
  readonly refused?: string;
}

interface Subject {
  readonly label: string;
  readonly run: (engine: Engine) => string;
}

function attempt(run: () => string): Outcome {
  try {
    return { output: run() };
  } catch (err) {
    return { refused: (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '' };
  }
}

function subjects(): Subject[] {
  const out: Subject[] = [];
  for (const file of readFixtureFiles(CASES_DIR)) {
    for (const testCase of file.doc.cases) {
      out.push({
        label: `case ${file.file.replace(/\.json$/, '')}/${testCase.name}`,
        run: (engine) => renderCase(testCase, engine),
      });
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'tdc-engine-sweep-'));
  process.on('exit', () => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const examples = allExamples().filter((e) => e.skip === undefined);
  for (const example of examples) {
    const path = join(scratch, `ex-${String(out.length)}.tdc`);
    writeFileSync(path, example.config);
    out.push({
      label: `doc ${example.name}#${String(example.index)}`,
      run: (engine) =>
        new TDC({
          configFile: path,
          engine,
          now: Date.parse(`${DOC_NOW}T00:00:00Z`),
        }).toString(),
    });
  }
  return out;
}

const verbose = process.argv.includes('--verbose');
const all = subjects();
let agreed = 0;
let refusedEverywhere = 0;
let arranged = 0;
const disagreements: { label: string; outcomes: Map<Engine, Outcome> }[] = [];

for (const subject of all) {
  const outcomes = new Map<Engine, Outcome>();
  for (const engine of ENGINES)
    outcomes.set(
      engine,
      attempt(() => subject.run(engine)),
    );
  const produced = [...outcomes.values()].filter((o) => o.output !== undefined);
  if (produced.length === 0) {
    refusedEverywhere += 1;
    continue;
  }
  const first = produced[0]?.output;
  const outputsAgree = produced.every((o) => o.output === first);
  // An engine that STOPPED on an assert the others passed has disagreed, refusal or not.
  const assertSplit = [...outcomes.values()].some((o) => o.refused?.includes('assert failed'));
  if (outputsAgree && !assertSplit) {
    agreed += 1;
  } else if (!assertSplit && ARRANGED_DIFFERENTLY.has(subject.label)) {
    arranged += 1;
  } else {
    disagreements.push({ label: subject.label, outcomes });
  }
}

console.log(`${String(all.length)} configs × engines ${ENGINES.join(', ')}`);
console.log(`  ${String(agreed)} agree on every engine that renders them`);
console.log(
  `  ${String(refusedEverywhere)} refused by every engine (fragments, deliberate refusals)`,
);
console.log(`  ${String(arranged)} laid out differently by design (ARRANGED_DIFFERENTLY)`);
console.log(`  ${String(disagreements.length)} disagree`);
for (const d of disagreements) {
  console.log(`\n✗ ${d.label}`);
  for (const [engine, o] of d.outcomes) {
    const shown =
      o.output !== undefined
        ? verbose
          ? o.output
          : `${String(o.output.split('\n').length)} lines, first: ${o.output.split('\n')[0]?.slice(0, 80) ?? ''}`
        : `refused: ${o.refused?.slice(0, 120) ?? ''}`;
    console.log(`    engine ${String(engine)}: ${shown}`);
  }
}
process.exit(disagreements.length === 0 ? 0 : 1);
