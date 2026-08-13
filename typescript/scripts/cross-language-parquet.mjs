#!/usr/bin/env node
/**
 * The Parquet fixture: a config, and the exact bytes it must produce.
 *
 * Two Parquet writers can both be correct and disagree byte for byte — the format leaves
 * compression and match-finding to the encoder, so "a reader opens it" is not the property this
 * project promises. It promises the files MATCH, which only a digest can check.
 *
 * So each case records the file's length and its SHA-256. A port that produces a valid file with
 * different bytes fails here, which is the point: the moment two implementations diverge, one of
 * them has silently made a choice the other did not.
 *
 *   --update   rewrite the digests from current behaviour; the diff is the review.
 *   (default)  verify.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderParquet } from '../src/output/render-parquet.ts';
import { parseStrict } from '../src/parser/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(here, '..', '..', 'fixtures', 'cross-language');
const OUT = join(SHARED, 'parquet.json');
/** A case that reads a file names a folder here, the way the shared cases already do. */
const CASES_DIR = join(SHARED, 'cases');

const NOW = Date.parse('2026-04-23T12:00:00Z');
const update = process.argv.includes('--update');

/** Every case is a whole config, so the wiring is tested along with the encoder. */
const CASES = [
  {
    name: 'every-scalar-type',
    description: 'each scalar kind, a NULL column from missing=, and a ground-truth flag',
    config: `<tdc><env count="7" seed="golden-flat" inject="\${{%}}">
<sequence name="Id"><gen type="increment" value="1"/></sequence>
<sequence name="N"><gen type="number" value="10..99" missing="0.3"/></sequence>
<sequence name="P"><gen type="number" value="1..999" decimals="2"/></sequence>
<sequence name="C"><gen type="text" value="Moscow,Paris,Berlin" percent="50,30,20"/></sequence>
<sequence name="D"><gen type="date" range="1990-01-01..2000-12-31" format="YYYY-MM-DD"/></sequence>
<sequence name="K"><gen type="template" value="common.id.uuid"/></sequence>
<sequence name="R"><gen type="number" value="10..20" anomaly="0.4" anomaly_flag="F"/></sequence>
</env><block><line>
<data name="id">\${{Id}}</data><data name="n">\${{N}}</data><data name="p">\${{P}}</data>
<data name="city">\${{C}}</data><data name="born">\${{D}}</data><data name="key">\${{K}}</data>
<data name="r">\${{R}}</data><data name="flag">\${{F}}</data>
<data name="money" type="decimal(18,2)">\${{P}}</data>
</line></block></tdc>`,
  },
  {
    name: 'variable-length-lists',
    description: 'repeat= makes a list column; the repetition levels carry the shape',
    config: `<tdc><env count="12" seed="pq-list" inject="\${{%}}">
<sequence name="T"><gen type="number" value="1..9" repeat="1..3"/></sequence>
</env><block><line><data name="tags">\${{T}}</data></line></block></tdc>`,
  },
  {
    name: 'lists-with-null-elements',
    description: 'missing= on a repeating gen blanks ELEMENTS, not the list',
    config: `<tdc><env count="10" seed="pq-list-null" inject="\${{%}}">
<sequence name="T"><gen type="number" value="18..24" repeat="0..3" missing="0.4"/></sequence>
</env><block><line><data name="ages">\${{T}}</data></line></block></tdc>`,
  },
  {
    name: 'declared-types',
    description: 'types written by hand rather than derived: uint, float16, enum, json, timestamp',
    config: `<tdc><env count="9" seed="pq-declared" inject="\${{%}}">
<sequence name="U"><gen type="number" value="0..250"/></sequence>
<sequence name="H"><gen type="number" value="1..99" decimals="1"/></sequence>
<sequence name="E"><gen type="text" value="new,active,closed"/></sequence>
<sequence name="B"><gen type="text" value="true,false"/></sequence>
</env><block><line>
<data name="small" type="uint8">\${{U}}</data><data name="half" type="float16">\${{H}}</data>
<data name="state" type="enum">\${{E}}</data><data name="ok" type="bool">\${{B}}</data>
<data name="wide" type="uint64">\${{U}}</data>
</line></block></tdc>`,
  },
  {
    name: 'repeated-categories-dictionary',
    description: 'a column of few distinct values, where a dictionary has to pay for itself',
    config: `<tdc><env count="400" seed="pq-dict" inject="\${{%}}">
<sequence name="C"><gen type="text" value="Moscow,Paris,Berlin,Rome" percent="40,30,20,10"/></sequence>
</env><block><line><data name="city">\${{C}}</data></line></block></tdc>`,
  },
  {
    name: 'inferred-derived-types',
    description: 'a column no one declared a type for, typed from the generator that feeds it',
    config: `<tdc><env count="8" seed="pq-derived" inject="\${{%}}" mode="memory">
<sequence name="W"><gen type="number" value="60..90"/></sequence>
<sequence name="H"><gen type="number" value="150..190"/></sequence>
<sequence name="Bmi"><gen type="formula" expr="W * 10000 / (H * H)" decimals="1"/></sequence>
<sequence name="Whole"><gen type="formula" expr="W + H" decimals="0"/></sequence>
<sequence name="Total"><gen type="running" of="W" accumulate="sum"/></sequence>
<sequence name="Avg"><gen type="stat" of="W" op="mean"/></sequence>
<sequence name="Sig"><gen type="pattern" points="0,0 5,100 10,0" y_range="0..10" decimals="2"/></sequence>
</env><block><line>
<data name="w">\${{W}}</data><data name="bmi">\${{Bmi}}</data><data name="whole">\${{Whole}}</data>
<data name="total">\${{Total}}</data><data name="avg">\${{Avg}}</data><data name="sig">\${{Sig}}</data>
</line></block></tdc>`,
  },
  {
    name: 'quantile-columns-are-numbers',
    description: 'read="quantile" is numeric by construction; an ordinary file read stays text',
    dataPath: 'data',
    config: `<tdc><env count="8" seed="pq-quantile" inject="\${{%}}">
<sequence name="A"><gen type="file" src="sample-amounts.txt" read="quantile"/></sequence>
<sequence name="G"><gen type="file" src="sample-ages.txt" read="quantile" decimals="0"/></sequence>
<sequence name="B"><gen type="file" src="sample-ages.txt"/></sequence>
</env><block><line>
<data name="amount">\${{A}}</data><data name="age">\${{G}}</data><data name="raw">\${{B}}</data>
</line></block></tdc>`,
  },
  {
    name: 'two-row-groups',
    description: 'more rows than one group holds — the offsets in the footer have to follow',
    config: `<tdc><env count="60000" seed="pq-groups" inject="\${{%}}">
<sequence name="Id"><gen type="increment" value="1"/></sequence>
</env><block><line><data name="id">\${{Id}}</data></line></block></tdc>`,
  },
];

const results = CASES.map((testCase) => {
  const options = { now: NOW };
  if (testCase.dataPath !== undefined) options.dataPaths = [join(CASES_DIR, testCase.dataPath)];
  const bytes = renderParquet(parseStrict(testCase.config), options);
  return {
    name: testCase.name,
    description: testCase.description,
    config: testCase.config,
    ...(testCase.dataPath === undefined ? {} : { dataPath: testCase.dataPath }),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});

const document = {
  schemaVersion: 1,
  comment:
    'Parquet files, by length and digest. Rendered with now=2026-04-23T12:00:00Z. ' +
    'A case with `dataPath` names a folder under cases/ holding the files it reads. ' +
    'Regenerate with: npm run parquet -- --update',
  now: '2026-04-23T12:00:00Z',
  cases: results,
};

if (update) {
  writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`parquet.json: ${results.length} cases written`);
  process.exit(0);
}

let current;
try {
  current = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  console.error(`${OUT} is missing or unreadable — run: npm run parquet -- --update`);
  process.exit(1);
}
const failures = [];
for (const expected of current.cases) {
  const actual = results.find((r) => r.name === expected.name);
  if (!actual) {
    failures.push(`${expected.name}: the case is gone from the script`);
    continue;
  }
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    failures.push(
      `${expected.name}\n  expected: ${expected.size} bytes, ${expected.sha256}\n` +
        `  actual:   ${actual.size} bytes, ${actual.sha256}`,
    );
  }
}
if (failures.length > 0) {
  console.error(`Parquet output changed:\n\n${failures.join('\n\n')}\n`);
  console.error('If the change is intended, run `npm run parquet:update` and review the diff.');
  process.exit(1);
}
console.log(`parquet.json: ${results.length} cases match the reference`);
