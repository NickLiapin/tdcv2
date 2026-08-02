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
 * Conditional-rendering end-to-end. The fixture declares three sequences
 * (UID as increment-counter, Gender, Age as a random int) and a single
 * <line if="Age >= 18">; we assert that:
 *
 *   1. the byte-identical baseline captured at implementation time
 *      continues to hold,
 *   2. lines for rows with Age < 18 are entirely absent from the output
 *      (neither the line nor its delimiter emits),
 *   3. UID values that appear in the output are the counter values of
 *      the rows that passed the filter — NOT 1, 2, 3... of the surviving
 *      rows. This proves sequences are materialised BEFORE the render
 *      loop and the counter advances for every row regardless of `if`.
 */
describe('processor — conditional rendering (if + counter + age gate)', () => {
  it('renders tdc_conditional_demo.xml byte-identical to the captured baseline', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_conditional_demo.xml'), 'utf8');
    const expected = readFileSync(join(fixturesDir, 'expected-tdc_conditional_demo.out'), 'utf8');
    const tree = parseStrict(dsl);
    // Baseline captured from Engine 1 — pin mode="memory" (disk is now default).
    const actual = render(tree, { now: FIXED_NOW, mode: 'memory' });
    expect(actual).toBe(expected);
  });

  it('every emitted data row has Age >= 18', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_conditional_demo.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    const body = out
      .split('\n')
      .slice(1) // header
      .filter((l) => l.length > 0);
    for (const row of body) {
      const age = Number(row.split(',')[2]);
      expect(age).toBeGreaterThanOrEqual(18);
    }
  });

  it('UID counter values show gaps where the if filter rejected a row', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_conditional_demo.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    const uids = out
      .split('\n')
      .slice(1)
      .filter((l) => l.length > 0)
      .map((l) => Number(l.split(',')[0]));
    // Counter started at 1000 with step 1 over 20 iterations, so
    // emitted UIDs are a subset of 1000..1019. The body must be shorter
    // than 20 (some rows were filtered) and each UID must fall in range.
    expect(uids.length).toBeLessThan(20);
    for (const uid of uids) {
      expect(uid).toBeGreaterThanOrEqual(1000);
      expect(uid).toBeLessThanOrEqual(1019);
    }
    // Gaps are proven by the non-monotonic step-of-1 expectation:
    // max - min + 1 > uids.length means at least one UID is missing.
    const minUid = Math.min(...uids);
    const maxUid = Math.max(...uids);
    expect(maxUid - minUid + 1).toBeGreaterThan(uids.length);
  });
});
