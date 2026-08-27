/**
 * What the library says about which engine a run will use, and how many rows.
 *
 * These are not cosmetic readings. The CLI asks `usesSeekableEngine()` before
 * it splits a run across worker threads, and a wrong "yes" is expensive: a
 * worker is handed a FORCED engine, which has no fallback, so a config the
 * renderer would have run in memory exits 1 with zero rows. That happened —
 * the comment on `usesStreamEngine` records the measurement — and nothing
 * pinned the answers afterwards.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const config = (env: string, count = 8): string =>
  `<tdc><env count="${String(count)}" seed="pred" local="en" ${env}>` +
  '<sequence name="A"><gen type="number" value="1..9"/></sequence>' +
  '</env><block><line><data>${{A}}</data></line></block></tdc>';

const at = (options: Record<string, unknown>, env = '', count = 8): TDC =>
  new TDC({ configString: config(env, count), ...options });

describe('usesSeekableEngine', () => {
  it('is true for a plain config, which the router sends to a per-row engine', () => {
    expect(at({}).usesSeekableEngine()).toBe(true);
  });

  it('is false when the in-memory engine is asked for, by either spelling', () => {
    // `engine: 1` names it outright; `mode: "memory"` is the older escape
    // hatch. Both have to answer the same or the CLI splits a run that cannot
    // be split.
    expect(at({ engine: 1 }).usesSeekableEngine()).toBe(false);
    expect(at({ mode: 'memory' }).usesSeekableEngine()).toBe(false);
  });

  it('is true for the exact-on-disk engine', () => {
    expect(at({ engine: 3 }).usesSeekableEngine()).toBe(true);
  });

  it('reads mode="memory" written in the CONFIG, not only in the options', () => {
    expect(at({}, 'mode="memory"').usesSeekableEngine()).toBe(false);
  });
});

describe('usesStreamEngine', () => {
  it('is true only for the streaming engine, never for the other two', () => {
    expect(at({ engine: 2 }).usesStreamEngine()).toBe(true);
    expect(at({ engine: 1 }).usesStreamEngine()).toBe(false);
    expect(at({ engine: 3 }).usesStreamEngine()).toBe(false);
  });

  it('never says yes where usesSeekableEngine says no', () => {
    // Engine 2 is one of the seekable pair, so this implication has to hold.
    // A run that is not seekable cannot be streaming, and the CLI relies on it.
    for (const options of [{}, { engine: 1 }, { engine: 2 }, { engine: 3 }, { mode: 'memory' }]) {
      const t = at(options);
      if (t.usesStreamEngine()) expect(t.usesSeekableEngine()).toBe(true);
    }
  });
});

describe('count', () => {
  it('reads the count out of <env>', () => {
    expect(at({}, '', 12).count()).toBe(12);
  });

  it('lets an option override the config, which is what --count does', () => {
    expect(at({ count: 3 }, '', 12).count()).toBe(3);
  });

  it('gives the same number as effectiveCount, its older name', () => {
    const t = at({}, '', 7);
    expect(t.count()).toBe(t.effectiveCount());
  });

  it('agrees with the rows actually rendered', () => {
    // The point of the number: it has to predict the run, not describe intent.
    const t = at({ count: 5 }, '', 12);
    expect(t.toString().split('\n').filter(Boolean)).toHaveLength(t.count());
  });
});
