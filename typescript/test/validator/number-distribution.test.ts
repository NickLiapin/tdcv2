import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function run(source: string) {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return validate(result.tree);
}
const wrap = (body: string) =>
  `<tdc><env><sequence name="s">${body}</sequence></env><block><line><data>_</data></line></block></tdc>`;
const hasCode = (source: string, code: string): boolean =>
  run(source).diagnostics.some((d) => d.code === code);

describe('validator — number distributions', () => {
  it('accepts a well-formed distribution gen', () => {
    const r = run(wrap('<gen type="number" distribution="normal" mean="170" sd="10"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts optional decimals/min/max', () => {
    const r = run(
      wrap(
        '<gen type="number" distribution="pareto" alpha="2" xmin="10" min="10" max="1000" decimals="2"/>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('rejects an unknown distribution name (TDC089)', () => {
    expect(hasCode(wrap('<gen type="number" distribution="weird"/>'), 'TDC089')).toBe(true);
  });

  it('rejects missing required parameters (TDC089)', () => {
    expect(hasCode(wrap('<gen type="number" distribution="normal" mean="0"/>'), 'TDC089')).toBe(
      true,
    );
    expect(hasCode(wrap('<gen type="number" distribution="exponential"/>'), 'TDC089')).toBe(true);
  });

  it('rejects min>max and decimals<0 (TDC089)', () => {
    expect(
      hasCode(
        wrap('<gen type="number" distribution="normal" mean="0" sd="1" min="9" max="1"/>'),
        'TDC089',
      ),
    ).toBe(true);
    expect(
      hasCode(
        wrap('<gen type="number" distribution="normal" mean="0" sd="1" decimals="-1"/>'),
        'TDC089',
      ),
    ).toBe(true);
  });

  it('accepts the slice-2 distributions (weibull/poisson/zipf)', () => {
    expect(
      hasErrors(
        run(wrap('<gen type="number" distribution="weibull" shape="2" scale="10"/>')).diagnostics,
      ),
    ).toBe(false);
    expect(
      hasErrors(run(wrap('<gen type="number" distribution="poisson" lambda="4"/>')).diagnostics),
    ).toBe(false);
    expect(
      hasErrors(run(wrap('<gen type="number" distribution="zipf" n="100" s="1.1"/>')).diagnostics),
    ).toBe(false);
  });

  it('rejects bad slice-2 parameters (TDC089)', () => {
    expect(hasCode(wrap('<gen type="number" distribution="poisson"/>'), 'TDC089')).toBe(true);
    expect(hasCode(wrap('<gen type="number" distribution="zipf" n="2.5" s="1"/>'), 'TDC089')).toBe(
      true,
    );
  });

  it('accepts gamma/beta and rejects their bad params', () => {
    expect(
      hasErrors(
        run(wrap('<gen type="number" distribution="gamma" shape="2" scale="1"/>')).diagnostics,
      ),
    ).toBe(false);
    expect(
      hasErrors(
        run(wrap('<gen type="number" distribution="beta" alpha="2" beta="3"/>')).diagnostics,
      ),
    ).toBe(false);
    expect(hasCode(wrap('<gen type="number" distribution="gamma" shape="2"/>'), 'TDC089')).toBe(
      true,
    );
    expect(hasCode(wrap('<gen type="number" distribution="beta" alpha="2"/>'), 'TDC089')).toBe(
      true,
    );
  });

  it('rejects combining a distribution with a range or percent (TDC088)', () => {
    expect(
      hasCode(
        wrap('<gen type="number" distribution="normal" mean="0" sd="1" value="0..9"/>'),
        'TDC088',
      ),
    ).toBe(true);
    expect(
      hasCode(
        wrap('<gen type="number" distribution="normal" mean="0" sd="1" percent="50,50"/>'),
        'TDC088',
      ),
    ).toBe(true);
  });
});
