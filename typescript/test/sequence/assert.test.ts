/**
 * `<assert that="…" says="…"/>` — a config that checks its own output.
 *
 * The property under test throughout is the one the feature exists for: a run
 * whose emergent shape drifts away from what the config appears to promise, and
 * which nothing else in the engine would ever mention. Percentages that survive
 * a filter, a maximum that a `missing=` column quietly emptied, a chain of
 * shares that no longer sums to the whole.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

function run(env: string, count = 1000): string {
  const config =
    `<tdc><env count="${String(count)}" seed="s" local="en">${env}</env>` +
    '<block><line><data>${{_count}}</data></line></block></tdc>';
  return new TDC({ configString: config, now: NOW }).toString();
}

const KIND = '<sequence name="Kind"><gen type="text" value="a,b" percent="70,30"/></sequence>';
const AMOUNT =
  '<sequence name="Amount" parent="Kind.a"><gen type="number" value="1..100"/></sequence>';
const ROWS = '<sequence name="Rows"><gen type="stat" of="Amount" op="count"/></sequence>';

describe('<assert> — the run checks itself', () => {
  it('says nothing when the run holds up the claim', () => {
    expect(() =>
      run(`${KIND}${AMOUNT}${ROWS}<assert that="Rows == 700" says="70% of rows carry an amount"/>`),
    ).not.toThrow();
  });

  it('stops the run when a second filter has quietly eaten into the share', () => {
    // The config still reads `percent="70"`. Nothing in it states that only the
    // gold rows get an amount as well, so the surviving share is 42% and no
    // existing check has an opinion. This is the failure the feature is for.
    const tier =
      '<sequence name="Tier"><gen type="text" value="gold,plain" percent="60,40"/></sequence>';
    const amount =
      '<sequence name="Amount" parent="Kind.a"><gen type="number" value="1..100" if="Tier == \'gold\'"/></sequence>';
    expect(() =>
      run(
        `${KIND}${tier}${amount}${ROWS}<assert that="Rows == 700" says="every a-row has an amount"/>`,
      ),
    ).toThrow(/every a-row has an amount/);
  });

  it('shows the value that was actually there, not only "false"', () => {
    const tier =
      '<sequence name="Tier"><gen type="text" value="gold,plain" percent="60,40"/></sequence>';
    const amount =
      '<sequence name="Amount" parent="Kind.a"><gen type="number" value="1..100" if="Tier == \'gold\'"/></sequence>';
    expect(() =>
      run(`${KIND}${tier}${amount}${ROWS}<assert that="Rows == 700" says="…"/>`),
    ).toThrow(/Rows = 600/);
  });

  it('reads more than one name, and reports every one it read', () => {
    const total = '<sequence name="Total"><gen type="stat" of="Amount" op="sum"/></sequence>';
    expect(() =>
      run(
        `${KIND}${AMOUNT}${ROWS}${total}` +
          '<assert that="Total > Rows * 1000" says="the average amount is far below 1000"/>',
      ),
    ).toThrow(/Rows = 700.*Total = |Total = .*Rows = 700/s);
  });

  it('checks every assertion, not only the first', () => {
    expect(() =>
      run(
        `${KIND}${AMOUNT}${ROWS}` +
          '<assert that="Rows == 700" says="first, and it holds"/>' +
          '<assert that="Rows < 10" says="second, and it does not"/>',
      ),
    ).toThrow(/second, and it does not/);
  });

  it('refuses a per-row column rather than checking row 0 and calling the run verified', () => {
    // The whole disease this project is about: a check that passes because it
    // barely looked. `Amount > 0` over a thousand rows would read one.
    expect(() =>
      run(
        '<sequence name="Amount"><gen type="number" value="1..100"/></sequence>' +
          '<assert that="Amount > 0" says="amounts are positive"/>',
      ),
    ).toThrow(/is not the same on every row/);
  });

  it('accepts a one-value column, because the rule is about the data, not the spelling', () => {
    expect(() =>
      run(
        '<sequence name="Env"><gen type="text" value="prod"/></sequence>' +
          '<assert that="Env == \'prod\'" says="the fixture is built for production"/>',
      ),
    ).not.toThrow();
  });

  it('accepts _total, which is the count of rows on every row', () => {
    expect(() =>
      run('<assert that="_total == 1000" says="the run is a thousand rows"/>'),
    ).not.toThrow();
    expect(() => run('<assert that="_total == 999" says="off by one"/>')).toThrow(/off by one/);
  });

  it('checks every name in the expression, whichever side of && it is on', () => {
    // The evaluator walks both operands rather than short-circuiting, so a
    // per-row column is refused wherever it sits. That the refusal does not
    // depend on operand order is the point: the same config must be refused the
    // same way in all five implementations.
    for (const expr of ['_total == 1000 && Amount > 0', 'Amount > 0 && _total == 1000']) {
      expect(() =>
        run(
          '<sequence name="Amount"><gen type="number" value="1..100"/></sequence>' +
            `<assert that="${expr}" says="…"/>`,
        ),
      ).toThrow(/"Amount" is not the same on every row/);
    }
  });

  it('catches the shape percentages cannot: a share that no longer sums to the whole', () => {
    const env =
      '<sequence name="Plan"><gen type="text" value="free,paid" percent="80,20"/></sequence>' +
      '<sequence name="Paid" parent="Plan.paid"><gen type="number" value="1..9"/></sequence>' +
      '<sequence name="Free" parent="Plan.free"><gen type="number" value="1..9"/></sequence>' +
      '<sequence name="P"><gen type="stat" of="Paid" op="count"/></sequence>' +
      '<sequence name="F"><gen type="stat" of="Free" op="count"/></sequence>' +
      '<assert that="P + F == _total" says="every row belongs to exactly one plan"/>';
    expect(() => run(env)).not.toThrow();
  });

  it('fails before a single line is written', () => {
    // A file that exists is a file someone will use. The check runs while the
    // run is being prepared, so a failed assertion leaves no output behind.
    let produced = '';
    try {
      produced = run(`${KIND}${AMOUNT}${ROWS}<assert that="Rows == 1" says="no"/>`);
    } catch {
      /* expected */
    }
    expect(produced).toBe('');
  });
});
