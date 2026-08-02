import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `/Users/.../tdcv2/typescript/test/parser/fixtures.test.ts` → fixtures at
// `/Users/.../tdcv2/fixtures/`
const fixturesDir = resolve(__dirname, '../..', '..', 'fixtures');

/**
 * Every `.xml` fixture in the shared `fixtures/` directory at the repo
 * root must parse without diagnostics. These are the 5 canonical output
 * formats migrated from the 2022-2024 prototype:
 *   tdc_csv.xml, tdc_json.xml, tdc_sql.xml, tdc_markdown.xml, tdc_txt.xml
 *
 * Passing this test is the explicit completion criterion for the parser
 * milestone (Phase 1 Week 3, docs/vision/START_HERE.md).
 */
describe('parser — repo-root regression fixtures', () => {
  const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.xml'));

  it('there are at least 5 fixtures (the 5 canonical formats)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(5);
  });

  it.each(fixtures)('parses %s without diagnostics', (fixtureName) => {
    const source = readFileSync(join(fixturesDir, fixtureName), 'utf8');
    const tree = parseStrict(source);
    // A successfully-parsed fixture has at least one top-level element.
    expect(tree.element().length).toBeGreaterThan(0);
  });
});
