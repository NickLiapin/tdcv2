/**
 * One row is a row.
 *
 * The in-memory engine derives a cell from `(seed, column, row)` the way the
 * streaming engines do — that is what makes the three agree. It reaches that
 * derivation through a loop that builds each row on its own, and the loop has
 * to stop: the inner call would otherwise walk straight back into it. It used
 * to stop by refusing any build of one row at all, which is not the same test.
 * A GENUINE one-row column — a `count="1"` run, or a `<mix>` case whose share
 * came to a single row — was refused along with the recursion and fell back to
 * the threaded PRNG, so it drew from a different stream than engines 2 and 3.
 *
 * The result was a config that produced two different datasets depending on
 * which engine ran it, which is the one promise the determinism page makes in
 * as many words. It was quiet because the SELECTION never moved: a mix put the
 * same case on the same row on every engine, and only the value inside it
 * differed.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const ENGINES = [1, 2, 3] as const;

function rows(config: string, engine: 1 | 2 | 3): string[] {
  const text = new TDC({ configString: config, engine }).toString();
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** The same config on all three engines, as three row lists. */
function onEveryEngine(config: string): string[][] {
  return ENGINES.map((e) => rows(config, e));
}

const plain = (count: number, gen: string): string =>
  `<tdc><env count="${String(count)}" seed="one" local="en">` +
  `<sequence name="X">${gen}</sequence>` +
  '</env><block><line><data>${{X}}</data></line></block></tdc>';

describe('a run of one row', () => {
  it.each([
    ['regex', '<gen type="regex" value="[a-e]{3}"/>'],
    ['number', '<gen type="number" value="1000..9999"/>'],
    ['symbol', '<gen type="symbol" value="[a-z]" length="4"/>'],
    ['date', '<gen type="date" from="2020-01-01" to="2024-12-31"/>'],
    ['template', '<gen type="template" value="person.lastName"/>'],
  ])('agrees on all three engines — %s', (_type, gen) => {
    const [one, two, three] = onEveryEngine(plain(1, gen));
    expect(one).toEqual(two);
    expect(two).toEqual(three);
  });

  it('is the FIRST row of a longer run, not a run of its own', () => {
    const gen = '<gen type="regex" value="[a-e]{3}"/>';
    for (const engine of ENGINES) {
      const alone = rows(plain(1, gen), engine);
      const among = rows(plain(5, gen), engine);
      expect(alone).toEqual([among[0]]);
    }
  });
});

describe('a <mix> case that comes to one row', () => {
  // A nested mix inside a NON-FIRST case. The inner case holds a single row at
  // these shares, which is exactly the shape that used to diverge.
  const nested = (count: number, outer: string, inner: string): string =>
    `<tdc><env count="${String(count)}" seed="7" local="en">` +
    `<mix name="P" percent="${outer}">` +
    '<case><data>A</data></case>' +
    `<case><mix percent="${inner}">` +
    '<case><gen type="regex" value="[a-e]"/></case>' +
    '<case><data>M</data></case>' +
    '</mix></case>' +
    '<case><data>C</data></case>' +
    '</mix></env><block><line><data>${{P}}</data></line></block></tdc>';

  it('draws the same value on all three engines', () => {
    for (const count of [2, 4, 6, 8, 10, 12, 20]) {
      for (const outer of ['25', '50', '75', '34,33', '20,60', '60,20']) {
        for (const inner of ['25', '50', '75']) {
          const config = nested(count, outer, inner);
          const [one, two, three] = onEveryEngine(config);
          expect(one, `count=${String(count)} outer=${outer} inner=${inner}`).toEqual(two);
          expect(two, `count=${String(count)} outer=${outer} inner=${inner}`).toEqual(three);
        }
      }
    }
  });

  it('never disagreed about WHICH case a row got — only about the value in it', () => {
    // The selection is a percentage layout keyed by (seed, streamId); it was
    // right all along. Kept as a test because it is what made the defect hard
    // to see: the shape of the column looked identical on every engine.
    const shape = (list: readonly string[]): string =>
      list.map((v) => (v === 'A' || v === 'C' || v === 'M' ? v : '?')).join('');
    const [one, two, three] = onEveryEngine(nested(20, '50', '50'));
    expect(shape(one ?? [])).toEqual(shape(two ?? []));
    expect(shape(two ?? [])).toEqual(shape(three ?? []));
  });
});
