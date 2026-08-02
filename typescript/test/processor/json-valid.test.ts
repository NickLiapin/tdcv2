import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '..', '..', '..', 'fixtures');

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Demonstrates the `<data if="!_last">,</data>` pattern — the answer to
 * the classic "how do I avoid a trailing comma in JSON" problem.
 *
 * The demo uses:
 *   - the built-in `_last` sequence (non-empty on the final iteration,
 *     empty elsewhere), and
 *   - the newly-grammar-supported `if` attribute on <data> tags
 *
 * to produce valid, parseable JSON without post-processing.
 */
describe('tdc_json_valid — trailing-comma fix via if on <data>', () => {
  it('matches the captured byte-exact baseline', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_json_valid.xml'), 'utf8');
    const expected = readFileSync(join(fixturesDir, 'expected-tdc_json_valid.out'), 'utf8');
    const tree = parseStrict(dsl);
    // in-memory engine is the canonical oracle for the captured baseline
    const actual = render(tree, { now: FIXED_NOW, mode: 'memory' });
    expect(actual).toBe(expected);
  });

  it('the produced output is valid JSON — JSON.parse accepts it', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_json_valid.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    const parsed = JSON.parse(out) as { users: { id: number }[] };
    expect(parsed.users).toHaveLength(5);
    expect(parsed.users[0]?.id).toBe(1);
    expect(parsed.users[4]?.id).toBe(5);
  });

  it('the last object in the array has no trailing comma', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_json_valid.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    // Find the last `}` before the closing `]` and verify it's not `},`.
    const closingBracketIdx = out.lastIndexOf(']');
    const region = out.slice(0, closingBracketIdx);
    const lastBrace = region.lastIndexOf('}');
    // After the last `}` up to `]`, no `,` may appear.
    expect(region.slice(lastBrace)).not.toContain(',');
  });

  it('every non-last object does have a trailing comma', () => {
    const dsl = readFileSync(join(fixturesDir, 'tdc_json_valid.xml'), 'utf8');
    const tree = parseStrict(dsl);
    const out = render(tree, { now: FIXED_NOW });
    // The generated text has four `},` sequences (for 5 users, N-1 = 4
    // commas).
    const matches = out.match(/\},/g) ?? [];
    expect(matches).toHaveLength(4);
  });
});
