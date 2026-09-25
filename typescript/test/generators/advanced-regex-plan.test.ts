import { describe, expect, it } from 'vitest';

import { advancedRegexGenerator } from '../../src/generators/advanced-regex.js';
import {
  advancedRegexSpaceSize,
  planAdvancedRegexColumn,
} from '../../src/generators/advanced-regex-plan.js';
import { createPrng } from '../../src/prng/prng.js';

/**
 * The two promises `uniq` over an `advanced_regex` pattern rests on, checked where they are made
 * rather than through a whole run.
 *
 * A dealt column is the plain generator's column — remembering which branches each row took must
 * not change a single value. And a redraw never leaves the branches its row was dealt: that is
 * what keeps every exact share exact, and the end-to-end tests can only see it indirectly.
 */
describe('a planned advanced_regex column', () => {
  it('deals exactly the column the plain generator deals', () => {
    for (const pattern of [
      '(?%{70:RU;30:US})-[0-9]{4}',
      '(?<s>(?%{50:M;50:F}))-(?if{s=M:[a-c];s=F:[x-z]})',
      '((?%{50:a;50:b})){1,3}',
      '(x|(?%{50:a;50:b}))[0-9]',
      '[A-Z]{2}[0-9]{3}',
    ]) {
      const plain = advancedRegexGenerator({ pattern })(500, createPrng('same'));
      const planned = planAdvancedRegexColumn({ pattern }, 500, createPrng('same'));
      expect(planned.values, pattern).toEqual(plain);
    }
  });

  it('a redraw keeps the branch its row was dealt, or gives nothing', () => {
    const column = planAdvancedRegexColumn(
      { pattern: '(x|(?%{50:a;50:b}))[0-9]' },
      300,
      createPrng('p'),
    );
    const prng = createPrng('redraws');
    let strayed = 0;
    column.values.forEach((value, row) => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const redrawn = column.redraw(row, prng);
        if (redrawn === undefined) {
          strayed += 1;
          continue;
        }
        expect(redrawn[0], `row ${String(row)} was dealt ${value}`).toBe(value[0]);
      }
    });
    // The alternation above the weighted choice is drawn afresh, so some walks do wander — and
    // every one that did came back as nothing rather than as a value on the other side.
    expect(strayed).toBeGreaterThan(0);
  });

  it('counts a share along the branches it took', () => {
    const column = planAdvancedRegexColumn(
      { pattern: '(?%{50:(?%{50:a;50:b});50:c})[0-9]{2}' },
      40,
      createPrng('shares'),
    );
    const spaces = new Map<string, number | undefined>();
    for (const key of column.pathKeys) spaces.set(column.describePath(key), column.pathSpace(key));
    expect(spaces).toEqual(
      new Map([
        ['50% (branch 1 of 2) → 50% (branch 1 of 2)', 100],
        ['50% (branch 1 of 2) → 50% (branch 2 of 2)', 100],
        ['50% (branch 2 of 2)', 100],
      ]),
    );
    expect(column.totalSpace).toBe(300);
  });

  it('cannot count a share apart when a weighted choice sits under something drawn', () => {
    for (const pattern of [
      '((?%{50:a;50:b})){2}',
      '(x|(?%{50:a;50:b}))',
      '(?<g>[ab])(?if{g=a:(?%{50:c;50:d})})',
    ]) {
      const column = planAdvancedRegexColumn({ pattern }, 10, createPrng('under'));
      expect(column.pathSpace(column.pathKeys[0] ?? ''), pattern).toBeUndefined();
    }
  });

  it('counts a conditional as its branches, plus the row that matches none', () => {
    // g=a → c|d; anything else matches no branch and adds nothing: 2 + 1 outcomes per group value.
    expect(advancedRegexSpaceSize({ pattern: '(?<g>[ab])(?if{g=a:[cd]})' })).toBe(2 * 3);
    // With a `*` branch no row falls through, so nothing is added.
    expect(advancedRegexSpaceSize({ pattern: '(?<g>[ab])(?if{g=a:[cd];*:e})' })).toBe(2 * 3);
    expect(advancedRegexSpaceSize({ pattern: '(?<g>[ab])(?if{g=a:[cd];*:[ef]})' })).toBe(2 * 4);
  });
});
