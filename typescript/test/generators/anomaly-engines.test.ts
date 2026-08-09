/**
 * `anomaly=` must mean the same thing on every engine.
 *
 * The in-memory engine spikes through `applyAnomaly`, which keeps the value's
 * shape and records what ACTUALLY happened to the row. The streaming engine had
 * its own copy of both decisions and got both wrong, so the default engine — the
 * one a plain `./run` uses — disagreed with the documented behaviour:
 *
 *     value=abc flag=true       a text row, never spiked, labelled an outlier
 *     price=199.89999999999998  a float artifact where 19.99 had two places
 *     zip=294                   where 00042 was five characters wide
 *     rep=[73.5,73.5]           where the plain column kept 73.50
 *
 * Every expectation here was measured against the unfixed engine first; the
 * strings above are what it produced.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

function run(config: string, engine?: 1 | 2 | 3): string[] {
  return new TDC({ configString: config, ...(engine ? { engine } : {}) })
    .toString()
    .trimEnd()
    .split('\n');
}

/** The three engines, so a divergence is named rather than averaged away. */
function allEngines(config: string): { one: string[]; two: string[]; three: string[] } {
  return { one: run(config, 1), two: run(config, 2), three: run(config, 3) };
}

const FLAG_CONFIG =
  '<tdc version="0.01"><env count="6" seed="s1" local="en">' +
  '<sequence name="V"><gen type="text" value="10,abc" order="sequential" ' +
  'anomaly="1" anomaly_factor="10" anomaly_flag="F"/></sequence></env>' +
  '<block><line><data>${{V}} ${{F}}</data></line></block></tdc>';

const SHAPE_CONFIG =
  '<tdc version="0.01"><env count="3" seed="s1" local="en">' +
  '<sequence name="P"><gen type="text" value="19.99" anomaly="1" anomaly_factor="10"/></sequence>' +
  '<sequence name="Z"><gen type="text" value="00042" anomaly="1" anomaly_factor="7"/></sequence>' +
  '</env><block><line><data>${{P}} ${{Z}}</data></line></block></tdc>';

describe('the anomaly flag records the outcome, not the selection', () => {
  it('leaves a text row false even when its draw selected it', () => {
    // anomaly="1" selects EVERY row; only the numeric ones can actually spike.
    expect(run(FLAG_CONFIG, 1)).toEqual([
      '100 true',
      'abc false',
      '100 true',
      'abc false',
      '100 true',
      'abc false',
    ]);
  });

  it('says the same on all three engines', () => {
    const { one, two, three } = allEngines(FLAG_CONFIG);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
  });
});

describe('a spike keeps the shape of the value it replaced', () => {
  it('keeps the decimal places and the zero padding', () => {
    expect(run(SHAPE_CONFIG, 1)).toEqual(['199.90 00294', '199.90 00294', '199.90 00294']);
  });

  it('is byte-identical on all three engines', () => {
    const { one, two, three } = allEngines(SHAPE_CONFIG);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
  });

  it('keeps it on a repeated column too', () => {
    // The `repeat=` path spikes each element through its own modifier rather
    // than through applyAnomaly, and used to re-stringify.
    const config =
      '<tdc version="0.01"><env count="2" seed="s1" local="en">' +
      '<sequence name="R"><gen type="text" value="73.50" anomaly="1" ' +
      'anomaly_factor="1" repeat="2" separator=","/></sequence></env>' +
      '<block><line><data>${{R}}</data></line></block></tdc>';
    expect(run(config, 1)).toEqual(['73.50,73.50', '73.50,73.50']);
    expect(run(config, 2)).toEqual(run(config, 1));
  });
});
