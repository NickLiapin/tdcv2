import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

/**
 * `uniq="true"` used to refuse work it could do.
 *
 * `enforceUniq` may only REARRANGE the values already drawn — rearranging is
 * what keeps `percent=` exact — so an uneven draw could make a perfectly
 * satisfiable config fail:
 *
 *     4 values × 8 values, count=20   ->  32 combinations exist
 *     drawn: a1×7 a2×6 a3×3 a4×4      ->  "its data supports at most 19"
 *
 * The lists were never short. Now an infeasible arrangement triggers a fresh
 * draw, up to a bounded number of attempts.
 *
 * The redraw runs ONLY where the old code threw, so nothing that worked can
 * change — `test/processor/fixtures.test.ts` and the cross-language goldens
 * are the guard for that half.
 */
describe('uniq redraws an unlucky sample', () => {
  const out = (src: string): string[] =>
    render(parseStrict(src), { now: 0, mode: 'memory' }).trim().split('\n').filter(Boolean);

  const wrap = (env: string, body = '${{K.a}}-${{K.b}}'): string =>
    `<tdc>${env}<block><line><data>${body}</data></line></block></tdc>`;

  it('makes 20 unique rows out of a 4 × 8 pool that a single draw could not arrange', () => {
    const rows = out(
      wrap(
        '<env count="20" seed="u"><sequence name="K" uniq="true">' +
          '<gen name="a" type="text" value="a1,a2,a3,a4"/>' +
          '<gen name="b" type="text" value="b1,b2,b3,b4,b5,b6,b7,b8"/>' +
          '</sequence></env>',
      ),
    );
    expect(rows).toHaveLength(20);
    expect(new Set(rows).size).toBe(20);
  });

  it('is deterministic — the same seed redraws to the same data', () => {
    const src = wrap(
      '<env count="20" seed="u"><sequence name="K" uniq="true">' +
        '<gen name="a" type="text" value="a1,a2,a3,a4"/>' +
        '<gen name="b" type="text" value="b1,b2,b3,b4,b5,b6,b7,b8"/>' +
        '</sequence></env>',
    );
    expect(out(src)).toEqual(out(src));
  });

  /**
   * The redraw must not become a way to paper over a real shortage: 2 × 2 is
   * four combinations however many times it is sampled.
   */
  it('still refuses a pool that genuinely cannot hold the count', () => {
    expect(() =>
      out(
        wrap(
          '<env count="10" seed="x"><sequence name="K" uniq="true">' +
            '<gen name="a" type="text" value="a,b"/>' +
            '<gen name="b" type="text" value="c,d"/>' +
            '</sequence></env>',
        ),
      ),
    ).toThrow(/cannot produce 10 unique combinations/);
  });

  /**
   * With `percent=` the proportions ARE the requirement, so every redraw
   * returns the same multiset. Detected after one attempt rather than retried
   * seven more times, and reported as what it is.
   */
  it('says the shares are what limits it, when a share is declared', () => {
    let message = '';
    try {
      out(
        wrap(
          '<env count="30" seed="p"><sequence name="K" uniq="true">' +
            '<gen name="a" type="text" value="a,b" percent="90,10"/>' +
            '<gen name="b" type="text" value="c,d,e" percent="80,10,10"/>' +
            '</sequence></env>',
        ),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('exact share');
    expect(message).toContain('relax the share');
    // The old wording blamed "its data", which reads as the value lists —
    // and the lists were not the problem.
    expect(message).not.toContain('its data supports at most');
  });

  it('keeps the exact shares it was given when the config IS satisfiable', () => {
    const rows = out(
      wrap(
        '<env count="20" seed="q"><sequence name="K" uniq="true">' +
          '<gen name="a" type="text" value="a1,a2,a3,a4" percent="25,25,25,25"/>' +
          '<gen name="b" type="text" value="b1,b2,b3,b4,b5,b6,b7,b8"/>' +
          '</sequence></env>',
      ),
    );
    expect(new Set(rows).size).toBe(20);
    const firsts = rows.map((r) => r.split('-')[0]);
    for (const v of ['a1', 'a2', 'a3', 'a4']) {
      expect(firsts.filter((f) => f === v)).toHaveLength(5);
    }
  });

  /**
   * The object API runs the in-memory engine and the text API does not, so
   * this config used to succeed one way and throw the other — on the same
   * instance, with the same seed.
   */
  it('agrees between the text and object paths', () => {
    const src = wrap(
      '<env count="20" seed="u"><sequence name="K" uniq="true">' +
        '<gen name="a" type="text" value="a1,a2,a3,a4"/>' +
        '<gen name="b" type="text" value="b1,b2,b3,b4,b5,b6,b7,b8"/>' +
        '</sequence></env>',
    );
    const text = render(parseStrict(src), { now: 0 }).trim().split('\n').filter(Boolean);
    expect(text).toHaveLength(20);
    expect(new Set(text).size).toBe(20);
    expect(out(src)).toHaveLength(20);
  });
});
