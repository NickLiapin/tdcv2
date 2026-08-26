import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { validate } from '../../src/validator/validate.js';

/**
 * `--count` decides how many rows the run makes, so it has to decide what the
 * warnings that are arithmetic over the count are about.
 *
 * Before this, the validator read the count off `<env>` and nothing else. Both
 * directions were wrong at once: a run stretched to 1,000 rows was warned about
 * 3, and a run cut to 3 rows — which really does ask for 0.99 of a record — was
 * not warned at all. A warning describing a run that is not happening is worse
 * than no warning, because it is read and acted on.
 */
const SHARES = (count: number): string => `
  <tdc>
    <env count="${String(count)}" seed="demo">
      <sequence name="V"><gen type="text" value="A,B,C" percent="34,33,33"/></sequence>
    </env>
    <block><line><data>\${{V}}</data></line></block>
  </tdc>`;

function codes(config: string, count?: number): string[] {
  const options = count === undefined ? {} : { count };
  return validate(parseStrict(config), options)
    .diagnostics.map((d) => d.code ?? '?')
    .filter((c) => c === 'TDC251');
}

describe('--count reaches the validator', () => {
  it('warns about a share below one record when the DECLARED count is small', () => {
    expect(codes(SHARES(3))).toEqual(['TDC251']);
  });

  it('stops warning when the override makes the share feasible', () => {
    expect(codes(SHARES(3), 1000)).toEqual([]);
  });

  it('starts warning when the override makes the share infeasible', () => {
    expect(codes(SHARES(1000))).toEqual([]);
    expect(codes(SHARES(1000), 3)).toEqual(['TDC251']);
  });

  it('names the row count the run will use, not the one in <env>', () => {
    const [warning] = validate(parseStrict(SHARES(1000)), { count: 3 }).diagnostics.filter(
      (d) => d.code === 'TDC251',
    );
    expect(warning?.message).toContain('over 3 rows');
  });

  it('leaves an unparseable declared count refused, override or not', () => {
    const bad = SHARES(3).replace('count="3"', 'count="x"');
    const all = validate(parseStrict(bad), { count: 10 }).diagnostics.map((d) => d.code);
    expect(all).toContain('TDC020');
  });
});
