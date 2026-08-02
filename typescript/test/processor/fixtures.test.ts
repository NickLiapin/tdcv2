import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const here = dirname(fileURLToPath(import.meta.url));
// test/processor → ../.. → typescript → .. → repo root
const repoRoot = resolve(here, '..', '..', '..');
const fixturesDir = join(repoRoot, 'fixtures');

/**
 * Each fixture in /fixtures/*.xml has a captured expected output in
 * /fixtures/expected-<name>.out, with a frozen reference clock of
 * 2026-04-23T12:00:00Z. The canonical oracle is the in-memory engine
 * (mode="memory", Engine 1) — the same baseline the cross-language
 * runtime fixtures pin. Our processor must reproduce it exactly.
 */
const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

interface Fixture {
  readonly name: string;
}
const FIXTURES: readonly Fixture[] = [
  { name: 'tdc_csv' },
  { name: 'tdc_json' },
  { name: 'tdc_sql' },
  { name: 'tdc_markdown' },
  { name: 'tdc_txt' },
];

describe('processor — end-to-end against the canonical fixtures', () => {
  it.each(FIXTURES)('renders $name byte-identical to the 2022-2024 prototype', ({ name }) => {
    const dsl = readFileSync(join(fixturesDir, `${name}.xml`), 'utf8');
    const expected = readFileSync(join(fixturesDir, `expected-${name}.out`), 'utf8');
    const tree = parseStrict(dsl);
    const actual = render(tree, { now: FIXED_NOW, mode: 'memory' });
    expect(actual).toBe(expected);
  });
});
