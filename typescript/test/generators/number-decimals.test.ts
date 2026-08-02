/**
 * `decimals=` on a plain range.
 *
 * It used to be honoured ONLY by `distribution=` and silently ignored on a
 * range, so `value="1..999" decimals="2"` produced whole numbers while the type
 * derivation went on declaring the column DOUBLE. That left no way at all to
 * generate a uniform fractional number — which is what money is — and our own
 * golden Parquet fixture had a DECIMAL(18,2) column that never held a kopeck.
 */

import { describe, expect, it } from 'vitest';

import { numberGenerator } from '../../src/generators/number.js';

/** A small deterministic PRNG so the assertions do not depend on the engine. */
const draw = (attrs: Parameters<typeof numberGenerator>[0], n = 200): readonly string[] => {
  let seed = 12345;
  const prng = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  return numberGenerator(attrs)(n, prng);
};

describe('number decimals on a range', () => {
  it('produces the requested number of decimal places', () => {
    for (const value of draw({ range: '1..999', decimals: 2 })) {
      expect(value, value).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('stays inside the declared range', () => {
    for (const value of draw({ range: '10..20', decimals: 1 })) {
      const n = Number(value);
      expect(n).toBeGreaterThanOrEqual(10);
      expect(n).toBeLessThanOrEqual(20);
    }
  });

  it('reaches both ends of the range, not just the middle', () => {
    // Scaling the bounds and drawing ONE integer keeps the endpoints
    // reachable; drawing a whole part and a fraction separately would not.
    const values = draw({ range: '1..2', decimals: 1 }, 500).map(Number);
    expect(Math.min(...values)).toBe(1);
    expect(Math.max(...values)).toBe(2);
  });

  it('leaves integers exactly as they were without the attribute', () => {
    expect(draw({ range: '1..999' })).toEqual(draw({ range: '1..999', decimals: 0 }));
    for (const value of draw({ range: '1..999' })) expect(value).toMatch(/^\d+$/);
  });

  it('spreads across several intervals', () => {
    const values = draw({ range: '[1..2],[100..101]', decimals: 1 }, 400).map(Number);
    expect(values.some((v) => v <= 2)).toBe(true);
    expect(values.some((v) => v >= 100)).toBe(true);
    expect(values.every((v) => v <= 2 || v >= 100)).toBe(true);
  });

  it('costs one draw per value, like an integer does', () => {
    // The per-row PRNG budget is what makes rows independent; a fractional
    // draw must not spend more than a whole one.
    let calls = 0;
    const counting = (): number => {
      calls += 1;
      return 0.5;
    };
    numberGenerator({ range: '1..999', decimals: 3 })(100, counting);
    expect(calls).toBe(100);
  });

  it('refuses a nonsensical precision', () => {
    expect(() => draw({ range: '1..9', decimals: -1 })).toThrow(/0\.\.10/);
    expect(() => draw({ range: '1..9', decimals: 2.5 })).toThrow(/integer/);
  });
});
