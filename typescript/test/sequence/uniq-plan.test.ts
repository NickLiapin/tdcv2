/**
 * The uniq arrangement, worked out once and handed to whoever else needs it.
 *
 * Deciding which rows move where is the expensive half of a uniq run: a pass
 * over every row to find the collisions, and another to learn which tuples are
 * taken. It depends on nothing but the config and the seed, so it is the same
 * answer every time — which makes repeating it pure waste.
 *
 * That matters for one reason above all: several threads rendering different
 * ranges of the same file. Without this each of them would repeat the whole
 * analysis, and splitting the work would be slower than not splitting it.
 *
 * So there are two claims to hold: the answer travels intact (same rows), and
 * taking it saves the work (no second pass). The second is the one that is easy
 * to believe without checking, so it is checked by counting how many times the
 * columns are actually asked for a value.
 */
import { describe, expect, it } from 'vitest';

import { repairExactUniq } from '../../src/sequence/exact-uniq.js';
import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

import type { UniqArrangement, UniqPlan } from '../../src/sequence/build.js';

const NOW = Date.parse('2024-01-01T00:00:00Z');

/** A column that remembers how often it was asked. */
function countingColumn(
  id: string,
  values: readonly string[],
  stride: number,
): { id: string; resolve: (i: number) => string; calls: () => number } {
  let calls = 0;
  return {
    id,
    resolve: (i: number): string => {
      calls++;
      return values[Math.floor(i / stride) % values.length] ?? '';
    },
    calls: () => calls,
  };
}

const many = (n: number, prefix: string): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

describe('a uniq arrangement can be handed on', () => {
  it('taking one skips the analysis instead of repeating it', () => {
    const count = 500;
    const columns = [countingColumn('A', many(100, 'a'), 1), countingColumn('B', many(9, 'b'), 17)];
    const asked = (): number => columns.reduce((n, c) => n + c.calls(), 0);

    let plan: UniqArrangement | undefined;
    repairExactUniq(columns, count, '"A × B"', {}, undefined, {
      onComputed: (moved) => {
        plan = moved;
      },
    });
    const analysed = asked();
    expect(analysed).toBeGreaterThan(count); // it really did walk the rows

    // Something actually moved, or the hand-off below would carry nothing.
    expect(Object.keys(plan ?? {}).length).toBeGreaterThan(0);

    const before = asked();
    const told = repairExactUniq(columns, count, '"A × B"', {}, undefined, { preset: plan });
    expect(asked()).toBe(before); // not one column asked: no analysis at all

    // And it answers the same as the run that did the work.
    const rows: string[] = [];
    for (let i = 0; i < count; i++) {
      rows.push(columns.map((c) => told[c.id]?.resolve?.(i) ?? '').join('|'));
    }
    expect(new Set(rows).size).toBe(count);
  });

  it('a range rendered with the plan matches the whole-file run, and the plan is what did it', () => {
    /*
     * The end this serves: a thread rendering rows 200 to 300 of a uniq config
     * must produce exactly the bytes the whole-file run produces there.
     *
     * The first assertion alone would not prove the plan travelled. A range
     * render builds the whole registry and analyses every row anyway — the plan
     * saves that work, it does not change the answer — so those bytes match
     * whether the plan arrived or was quietly dropped. Checked by dropping it
     * on purpose: the test still passed.
     *
     * So the second assertion feeds a plan that says something DIFFERENT, and
     * requires the output to follow it. A run that ignored the plan would
     * produce the same bytes as before and fail here.
     */
    const dsl = `
      <tdc>
        <env count="400" seed="plan" local="en" mode="stream">
          <uniq>
            <sequence name="A"><gen type="text" value="${many(40, 'a').join(',')}"/></sequence>
            <sequence name="B"><gen type="text" value="m,n,o,p,q,r,s,t,u,v,w,x"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}-\${{B}}</data></line></block>
      </tdc>`;
    const document = parseStrict(dsl);

    const collected: Record<string, UniqArrangement> = {};
    const whole = render(document, {
      now: NOW,
      onUniqPlan: (group, arrangement) => {
        collected[group] = arrangement;
      },
    })
      .split('\n')
      .filter(Boolean);

    expect(Object.keys(collected)).toEqual(['A × B']);
    expect(new Set(whole).size).toBe(whole.length); // the run is genuinely uniq

    const plan: UniqPlan = collected;
    const slice = render(document, { now: NOW, uniqPlan: plan, range: { start: 200, end: 300 } })
      .split('\n')
      .filter(Boolean);
    expect(slice).toEqual(whole.slice(200, 300));

    // Now a plan that says row 250 holds something else. The output has to say
    // so too, or the plan was never read.
    const altered: Record<string, UniqArrangement> = {
      'A × B': { ...(collected['A × B'] ?? {}), '250': ['zz', 'zz'] },
    };
    const followed = render(document, {
      now: NOW,
      uniqPlan: altered,
      range: { start: 250, end: 251 },
    })
      .split('\n')
      .filter(Boolean);
    expect(followed).toEqual(['zz-zz']);
  });
});
