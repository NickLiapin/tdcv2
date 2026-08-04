/**
 * A percentage inside a `<switch>` branch is a quota over THAT BRANCH's rows.
 *
 * Nick wrote this config expecting one man in five to carry a male-specific
 * diagnosis. He got none about a quarter of the time, and the engine said
 * nothing — which is the worst way for a promise to break, because it looks like
 * a working feature.
 *
 * Every branch used to be built over the WHOLE run, on both engines, as a
 * concession to streaming's O(1) lookup. So `<mix percent="20,80">` inside
 * `<case is="Male">` handed out its 20% over all ten rows, and the specials that
 * landed on female rows were discarded. Measured over 100 runs before the fix:
 * 0, 1 or 2 survivors per run, 23 runs with none at all. It was not randomness —
 * it was Hamilton over the wrong denominator, which is worse.
 *
 * ── What these tests are for ─────────────────────────────────────────────────
 * ONE seed proves nothing here: the old behaviour produced the right count on
 * roughly half its runs by luck. Each test therefore sweeps many seeds and
 * asserts the count is the same EVERY time — exactness is the claim, so an
 * average would let the bug back in.
 *
 * Both engines are asserted, and that is the point of the second block: the
 * first attempt at this fix touched only the in-memory engine, and the
 * measurements did not move at all, because a config like this resolves to the
 * streaming engine. A test on one engine would have passed while the thing Nick
 * actually runs stayed broken.
 */
import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

/** How many rows carry the special value, for each of `seeds` seeds. */
function perSeed(config: (seed: string) => string, special: string, seeds = 25): number[] {
  const counts: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const rows = new TDC({ configString: config(`s${String(s)}`) })
      .toString()
      .split('\n')
      .filter(Boolean);
    counts.push(rows.filter((r) => r.includes(special)).length);
  }
  return counts;
}

const CONFIG = (seed: string, engine?: string): string => `<tdc version="0.1">
  <env count="10" seed="${seed}" local="en"${engine === undefined ? '' : ` engine="${engine}"`}>
    <sequence name="G"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
    <switch name="D" on="G">
      <case is="Male">
        <mix percent="20,80">
          <case><gen type="text" value="SPECIAL"/></case>
          <case><gen type="text" value="ordinary"/></case>
        </mix>
      </case>
      <case is="Female"><gen type="text" value="other"/></case>
      <default></default>
    </switch>
  </env>
  <block><line><data>\${{G}},\${{D}}</data></line></block>
</tdc>`;

describe('a percentage inside a <switch> branch', () => {
  it('is a quota over the branch, not over the run', () => {
    // 20% of the five Male rows is exactly one. Not "about one".
    expect(new Set(perSeed((s) => CONFIG(s), ',SPECIAL'))).toEqual(new Set([1]));
  });

  it('gives the same answer on the in-memory and the streaming engine', () => {
    const memory = perSeed((s) => CONFIG(s, '1'), ',SPECIAL');
    const streaming = perSeed((s) => CONFIG(s, '2'), ',SPECIAL');
    expect(memory).toEqual(streaming);
    expect(new Set(memory)).toEqual(new Set([1]));
  });

  it('matches what the parent= form has always produced', () => {
    // `parent=` was exact before any of this and is the reference answer: a fix
    // that disagreed with it would be a second opinion, not a correction.
    const viaParent = (seed: string): string => `<tdc version="0.1">
  <env count="10" seed="${seed}" local="en">
    <sequence name="G"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
    <mix name="D" parent="G.Male" percent="20,80">
      <case><gen type="text" value="SPECIAL"/></case>
      <case><gen type="text" value="ordinary"/></case>
    </mix>
  </env>
  <block><line><data>\${{G}},\${{D}}</data></line></block>
</tdc>`;
    expect(new Set(perSeed(viaParent, ',SPECIAL'))).toEqual(new Set([1]));
  });

  it('draws a two-value list once each over a two-row branch', () => {
    // The sharpest form of the same fault: over its own two rows an unweighted
    // pair must give one of each. Built over the whole run it could repeat one
    // and skip the other — which is exactly what the uniq-with-a-switch shared
    // case used to pin.
    const config = (seed: string): string => `<tdc version="0.1">
  <env count="4" seed="${seed}" local="en">
    <sequence name="G"><gen type="text" value="M,F"/></sequence>
    <switch name="N" on="G">
      <case is="M"><gen type="text" value="ann,bob"/></case>
      <case is="F"><gen type="text" value="cat,dot"/></case>
    </switch>
  </env>
  <block><line><data>\${{G}}-\${{N}}</data></line></block>
</tdc>`;
    for (let s = 0; s < 25; s++) {
      const rows = new TDC({ configString: config(`s${String(s)}`) })
        .toString()
        .split('\n')
        .filter(Boolean);
      for (const value of ['ann', 'bob', 'cat', 'dot']) {
        expect(rows.filter((r) => r.endsWith(`-${value}`))).toHaveLength(1);
      }
    }
  });
});
