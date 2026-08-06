/**
 * `<gen type="stat">` — one number for the whole run, on every row.
 *
 * The values below are chosen so an implementation cannot pass by accident:
 * `2,4,4,4,5,5,7,9` is the textbook set whose POPULATION standard deviation is
 * exactly 2 (dividing by n−1 would give about 2.14), whose median is 4.5 and
 * whose mean is 5. A decimal column pins the exactness of `sum`, which is the
 * only reason `stat` reuses `running`'s arithmetic rather than adding doubles.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { statisticOf } from '../../src/sequence/stat.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** The whole run, as one column's worth of values. */
function column(op: string, values: string, extra = ''): string[] {
  const config =
    `<tdc><env count="${String(values.split(',').length)}" seed="s" local="en">` +
    `<sequence name="N"><gen type="text" value="${values}" order="sequential"/></sequence>` +
    `<sequence name="S"><gen type="stat" of="N" op="${op}"${extra}/></sequence>` +
    '</env><block><line><data>${{S}}</data></line></block></tdc>';
  return new TDC({ configString: config, now: NOW })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('stat — the seven statistics', () => {
  const SET = '2,4,4,4,5,5,7,9';

  it('gives every row the SAME value, which is what makes it not a running total', () => {
    const rows = column('mean', SET);
    expect(rows).toHaveLength(8);
    expect(new Set(rows).size).toBe(1);
    expect(rows[0]).toBe('5');
  });

  it('median takes the average of the two middle values on an even count', () => {
    expect(column('median', SET)[0]).toBe('4.5');
  });

  it('stddev is the POPULATION one — divided by n, not by n−1', () => {
    // n−1 would give 2.138…; the test would pass on either without this value.
    expect(column('stddev', SET)[0]).toBe('2');
  });

  it('sum, min and max', () => {
    expect(column('sum', SET)[0]).toBe('40');
    expect(column('min', SET)[0]).toBe('2');
    expect(column('max', SET)[0]).toBe('9');
  });

  it('count is how many rows carried a value', () => {
    expect(column('count', SET)[0]).toBe('8');
  });
});

describe('stat — the arithmetic it shares with a running total', () => {
  it('sums decimals exactly, because it is the running total read at the end', () => {
    // In floating point 19.99 + 0.01 + 0.01 is 20.009999999999998 in some hosts.
    expect(column('sum', '19.99,0.01,0.01')[0]).toBe('20.01');
  });

  it('min and max return the winning element with its own spelling', () => {
    expect(column('min', '007,10,9')[0]).toBe('007');
    expect(column('max', '10.50,9')[0]).toBe('10.50');
  });

  it('decimals= rounds, and a half goes AWAY FROM ZERO like everywhere else in TDC', () => {
    // 936.36 / 8 is 117.045 exactly; toward-even would answer 117.04.
    expect(
      column('mean', '181.44,86.56,168.24,178.89,41.53,111.89,29.34,138.47', ' decimals="2"')[0],
    ).toBe('117.05');
    // A half at zero is where the three host languages disagree most: mean 0.5
    // is 1 here and 0 under round-half-to-even; mean −0.5 is −1 here and −0 in
    // JavaScript. −1.5 would NOT tell them apart, which is why it is not used.
    expect(column('mean', '0,1', ' decimals="0"')[0]).toBe('1');
    expect(column('mean', '-1,0', ' decimals="0"')[0]).toBe('-1');
  });
});

describe('stat — the edges', () => {
  it('an empty column has no statistic, and says so with empty text rather than NaN', () => {
    expect(statisticOf([], 'mean', undefined)).toBe('');
    expect(statisticOf([undefined, undefined], 'sum', undefined)).toBe('');
  });

  it('but count still answers zero, because "how many" always has an answer', () => {
    expect(statisticOf([undefined, undefined], 'count', undefined)).toBe('0');
  });

  it('a row the parent filter emptied does not take part', () => {
    const config =
      '<tdc><env count="6" seed="s" local="en">' +
      '<sequence name="Kind"><gen type="text" value="a,b,a,b,a,b" order="sequential"/></sequence>' +
      '<sequence name="Amount" parent="Kind.a">' +
      '<gen type="text" value="10,20,30" order="sequential"/></sequence>' +
      '<sequence name="Total"><gen type="stat" of="Amount" op="sum"/></sequence>' +
      '<sequence name="Rows"><gen type="stat" of="Amount" op="count"/></sequence>' +
      '</env><block><line><data>${{Total}}/${{Rows}}</data></line></block></tdc>';
    const rows = new TDC({ configString: config, now: NOW })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    // Three of the six rows carry an Amount; the other three are outside the
    // filter and neither contribute to the total nor count towards it.
    expect(new Set(rows)).toEqual(new Set(['60/3']));
  });
});

describe('stat — the engine consequence, stated out loud', () => {
  const config =
    '<tdc><env count="4" seed="s" local="en">' +
    '<sequence name="N"><gen type="number" value="1..9"/></sequence>' +
    '<sequence name="Avg"><gen type="stat" of="N" op="mean"/></sequence>' +
    '</env><block><line><data>${{Avg}}</data></line></block></tdc>';

  it('a forced streaming engine refuses by name, and names the way out', () => {
    expect(() => new TDC({ configString: config, now: NOW, engine: 2 }).toString()).toThrow(
      /a statistic \("Avg"\) is computed over every row of the run/,
    );
  });

  it('left to itself the router hands it to the in-memory engine and it just runs', () => {
    const rows = new TDC({ configString: config, now: NOW })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(rows).toHaveLength(4);
    expect(new Set(rows).size).toBe(1);
  });
});

describe('stat — what the validator refuses before a row exists', () => {
  const check = (gen: string): string[] => {
    const config =
      '<tdc><env count="2" seed="s" local="en">' +
      '<sequence name="A"><gen type="text" value="1,2"/></sequence>' +
      `<sequence name="S">${gen}</sequence>` +
      '</env><block><line><data>${{S}}</data></line></block></tdc>';
    try {
      new TDC({ configString: config, now: NOW }).toString();
      return [];
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)];
    }
  };

  it('a statistic that does not say what to summarise, or which one', () => {
    expect(check('<gen type="stat" op="mean"/>')[0]).toMatch(/does not say what to summarise/);
    expect(check('<gen type="stat" of="A"/>')[0]).toMatch(/does not say which statistic/);
  });

  it('an op that is not one, answered with the near name', () => {
    expect(check('<gen type="stat" of="A" op="men"/>')[0]).toMatch(/op="men" is not one of/);
  });

  it('a column that is not declared above it', () => {
    expect(check('<gen type="stat" of="Nope" op="sum"/>')[0]).toMatch(
      /of="Nope" is not a sequence declared above this one/,
    );
  });

  it('a decimals= outside the range the formatting layer can hold', () => {
    expect(check('<gen type="stat" of="A" op="mean" decimals="99"/>')[0]).toMatch(
      /decimals="99" is not a whole number from 0 to 10/,
    );
  });
});
