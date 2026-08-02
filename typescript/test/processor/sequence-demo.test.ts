import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const fixturesDir = join(repoRoot, 'fixtures');

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Sequence-engine end-to-end test. This fixture exercises the full
 * parent-child dependency story described in docs/vision/02-sequences.md:
 *
 *   - root Gender sequence with percent="42,58"
 *   - ProstateIssue constrained to Gender.Male
 *   - BreastIssue constrained to Gender.Female
 *
 * The captured expected output (produced by this very implementation,
 * once, and checked in) asserts three invariants at once:
 *
 *   1. exact per-value counts at the root — 42 Male, 58 Female,
 *   2. exact per-value counts within the constrained subsets
 *      (20% of 42 = 8 yes / 34 no; 15% of 58 = 9 yes / 49 no),
 *   3. columns are empty for rows outside the filter (Male has no
 *      BreastIssue; Female has no ProstateIssue).
 *
 * Bit-identical reproducibility of this output is what Python and Java
 * ports must replicate — the fixture is the cross-language contract.
 */
describe('processor — sequence with parent-child dependency (demo fixture)', () => {
  it('renders tdc_sequence_demo.xml byte-identical to the captured baseline', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_sequence_demo.xml'), 'utf8');
    const expected = readFileSync(join(fixturesDir, 'expected-tdc_sequence_demo.out'), 'utf8');
    const tree = parseStrict(dsl);
    // Baseline captured from Engine 1 — pin mode="memory" (disk is now default).
    const actual = render(tree, { now: FIXED_NOW, mode: 'memory' });
    expect(actual).toBe(expected);
  });

  it('exactly 42 rows are Male and 58 are Female', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_sequence_demo.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    const rows = out.split('\n').filter((l) => l.includes(','));
    const header = rows[0];
    const body = rows.slice(1).filter((l) => l.length > 0);
    expect(header).toBe('ID,Gender,ProstateIssue,BreastIssue');
    expect(body).toHaveLength(100);
    expect(body.filter((r) => r.split(',')[1] === 'Male')).toHaveLength(42);
    expect(body.filter((r) => r.split(',')[1] === 'Female')).toHaveLength(58);
  });

  it('ProstateIssue is filled for every Male row and empty for every Female row', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_sequence_demo.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    const body = out
      .split('\n')
      .filter((l) => l.includes(','))
      .slice(1)
      .filter((l) => l.length > 0);
    for (const row of body) {
      const [, gender, prostate, breast] = row.split(',');
      if (gender === 'Male') {
        expect(prostate === 'yes' || prostate === 'no').toBe(true);
        expect(breast).toBe('');
      } else if (gender === 'Female') {
        expect(prostate).toBe('');
        expect(breast === 'yes' || breast === 'no').toBe(true);
      }
    }
  });

  it('percentages within each gender subset are exact: 8/34 male and 9/49 female', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_sequence_demo.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    const body = out
      .split('\n')
      .filter((l) => l.includes(','))
      .slice(1)
      .filter((l) => l.length > 0);
    const maleYes = body.filter((r) => {
      const parts = r.split(',');
      return parts[1] === 'Male' && parts[2] === 'yes';
    }).length;
    const maleNo = body.filter((r) => {
      const parts = r.split(',');
      return parts[1] === 'Male' && parts[2] === 'no';
    }).length;
    const femaleYes = body.filter((r) => {
      const parts = r.split(',');
      return parts[1] === 'Female' && parts[3] === 'yes';
    }).length;
    const femaleNo = body.filter((r) => {
      const parts = r.split(',');
      return parts[1] === 'Female' && parts[3] === 'no';
    }).length;
    expect(maleYes).toBe(8);
    expect(maleNo).toBe(34);
    expect(femaleYes).toBe(9);
    expect(femaleNo).toBe(49);
  });
});
