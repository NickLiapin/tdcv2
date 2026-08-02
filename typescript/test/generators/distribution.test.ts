/**
 * Statistical-distribution core — the pure, engine-agnostic sampler.
 *
 * Golden vectors come straight from the mathematical definitions (Box–Muller /
 * inverse-CDF), computed independently of the implementation. They are the
 * cross-language contract: any port must reproduce these exact numbers from the
 * same uniform inputs.
 */

import { describe, expect, it } from 'vitest';

import {
  formatSample,
  parseDistribution,
  sampleDistribution,
} from '../../src/generators/distribution.js';

describe('parseDistribution — draw counts', () => {
  it('reports how many uniform draws each distribution consumes', () => {
    expect(parseDistribution({ distribution: 'normal', mean: '0', sd: '1' }).draws).toBe(2);
    expect(parseDistribution({ distribution: 'lognormal', meanlog: '0', sdlog: '1' }).draws).toBe(
      2,
    );
    expect(parseDistribution({ distribution: 'exponential', rate: '1' }).draws).toBe(1);
    expect(parseDistribution({ distribution: 'pareto', alpha: '1', xmin: '1' }).draws).toBe(1);
  });
});

describe('sampleDistribution — golden vectors (the cross-language truth)', () => {
  const spec = (attrs: Record<string, string | undefined>) => parseDistribution(attrs);

  it('normal via Box–Muller', () => {
    expect(
      sampleDistribution(spec({ distribution: 'normal', mean: '0', sd: '1' }), [0.5, 0.5]),
    ).toBeCloseTo(-1.1774100225154747, 12);
    expect(
      sampleDistribution(spec({ distribution: 'normal', mean: '170', sd: '10' }), [0.2, 0.7]),
    ).toBeCloseTo(164.4558563340803, 10);
  });

  it('lognormal = exp(normal)', () => {
    expect(
      sampleDistribution(spec({ distribution: 'lognormal', meanlog: '0', sdlog: '1' }), [0.5, 0.5]),
    ).toBeCloseTo(0.30807561511624476, 12);
  });

  it('exponential via inverse-CDF', () => {
    expect(sampleDistribution(spec({ distribution: 'exponential', rate: '1' }), [0.5])).toBeCloseTo(
      0.6931471805599453,
      12,
    );
    expect(sampleDistribution(spec({ distribution: 'exponential', rate: '2' }), [0.9])).toBeCloseTo(
      0.05268025782891314,
      12,
    );
  });

  it('pareto via inverse-CDF', () => {
    expect(
      sampleDistribution(spec({ distribution: 'pareto', alpha: '1', xmin: '1' }), [0.5]),
    ).toBeCloseTo(2, 12);
    expect(
      sampleDistribution(spec({ distribution: 'pareto', alpha: '2.5', xmin: '100' }), [0.8]),
    ).toBeCloseTo(190.36539387158786, 10);
  });
});

describe('slice 2 — weibull / poisson / zipf', () => {
  const spec = (attrs: Record<string, string | undefined>) => parseDistribution(attrs);

  it('reports draw counts (all consume one uniform)', () => {
    expect(parseDistribution({ distribution: 'weibull', shape: '2', scale: '10' }).draws).toBe(1);
    expect(parseDistribution({ distribution: 'poisson', lambda: '4' }).draws).toBe(1);
    expect(parseDistribution({ distribution: 'zipf', n: '5', s: '1' }).draws).toBe(1);
  });

  it('weibull via inverse-CDF golden vectors', () => {
    expect(
      sampleDistribution(spec({ distribution: 'weibull', shape: '2', scale: '10' }), [0.5]),
    ).toBeCloseTo(8.325546111576976, 10);
    expect(
      sampleDistribution(spec({ distribution: 'weibull', shape: '1.5', scale: '100' }), [0.8]),
    ).toBeCloseTo(36.78941598907946, 10);
  });

  it('poisson via discrete inverse-CDF (integer counts)', () => {
    const p4 = spec({ distribution: 'poisson', lambda: '4' });
    expect(sampleDistribution(p4, [0.5])).toBe(4);
    expect(sampleDistribution(p4, [0.1])).toBe(2);
    expect(sampleDistribution(p4, [0.95])).toBe(8);
    expect(sampleDistribution(spec({ distribution: 'poisson', lambda: '10' }), [0.5])).toBe(10);
  });

  it('zipf via discrete inverse-CDF (integer ranks 1..n)', () => {
    const z = spec({ distribution: 'zipf', n: '5', s: '1' });
    expect(sampleDistribution(z, [0.5])).toBe(2);
    expect(sampleDistribution(z, [0.1])).toBe(1);
    expect(sampleDistribution(spec({ distribution: 'zipf', n: '10', s: '1.2' }), [0.9])).toBe(7);
  });

  it('validates the new parameters', () => {
    expect(() => parseDistribution({ distribution: 'weibull', shape: '2' })).toThrow(/scale/);
    expect(() => parseDistribution({ distribution: 'weibull', shape: '0', scale: '1' })).toThrow(
      /shape/,
    );
    expect(() => parseDistribution({ distribution: 'poisson' })).toThrow(/lambda/);
    expect(() => parseDistribution({ distribution: 'zipf', s: '1' })).toThrow(/n/);
    expect(() => parseDistribution({ distribution: 'zipf', n: '2.5', s: '1' })).toThrow(/n/); // n must be integer
  });
});

describe('slice 3 — gamma / beta (exact inverse-CDF via special functions)', () => {
  const spec = (attrs: Record<string, string | undefined>) => parseDistribution(attrs);

  it('reports draw counts (one uniform each)', () => {
    expect(parseDistribution({ distribution: 'gamma', shape: '2', scale: '1' }).draws).toBe(1);
    expect(parseDistribution({ distribution: 'beta', alpha: '2', beta: '3' }).draws).toBe(1);
  });

  it('gamma golden vectors (independent closed-form references)', () => {
    // gamma(shape=1) is exponential: inverse-CDF = -scale·ln(1-u).
    expect(
      sampleDistribution(spec({ distribution: 'gamma', shape: '1', scale: '1' }), [0.5]),
    ).toBeCloseTo(0.6931471805599453, 8);
    expect(
      sampleDistribution(spec({ distribution: 'gamma', shape: '1', scale: '2' }), [0.5]),
    ).toBeCloseTo(1.3862943611198906, 8);
    // gamma(shape=2, scale=1): median from F(x)=1-e^-x(1+x).
    expect(
      sampleDistribution(spec({ distribution: 'gamma', shape: '2', scale: '1' }), [0.5]),
    ).toBeCloseTo(1.67834699001666, 6);
    expect(
      sampleDistribution(spec({ distribution: 'gamma', shape: '2', scale: '1' }), [0.9]),
    ).toBeCloseTo(3.889720169867429, 6);
  });

  it('beta golden vectors (independent closed-form references)', () => {
    expect(
      sampleDistribution(spec({ distribution: 'beta', alpha: '1', beta: '1' }), [0.5]),
    ).toBeCloseTo(0.5, 8); // uniform
    expect(
      sampleDistribution(spec({ distribution: 'beta', alpha: '2', beta: '2' }), [0.5]),
    ).toBeCloseTo(0.5, 8); // symmetric
    // beta(1,2): F(x)=1-(1-x)^2 → inverse at u = 1-sqrt(1-u).
    expect(
      sampleDistribution(spec({ distribution: 'beta', alpha: '1', beta: '2' }), [0.5]),
    ).toBeCloseTo(0.2928932188134524, 7);
  });

  it('validates parameters', () => {
    expect(() => parseDistribution({ distribution: 'gamma', shape: '2' })).toThrow(/scale/);
    expect(() => parseDistribution({ distribution: 'gamma', shape: '0', scale: '1' })).toThrow(
      /shape/,
    );
    expect(() => parseDistribution({ distribution: 'beta', alpha: '2' })).toThrow(/beta/);
    expect(() => parseDistribution({ distribution: 'beta', alpha: '0', beta: '1' })).toThrow(
      /alpha/,
    );
  });
});

describe('formatSample — clip then round to decimals', () => {
  it('rounds to an integer by default', () => {
    const s = parseDistribution({ distribution: 'normal', mean: '0', sd: '1' });
    expect(formatSample(-1.1774100225, s)).toBe('-1');
    expect(formatSample(2.6, s)).toBe('3');
  });

  it('honours decimals=N', () => {
    const s = parseDistribution({ distribution: 'normal', mean: '0', sd: '1', decimals: '2' });
    expect(formatSample(-1.1774100225, s)).toBe('-1.18');
  });

  it('clips to min and max before rounding', () => {
    const lo = parseDistribution({ distribution: 'normal', mean: '0', sd: '1', min: '0' });
    expect(formatSample(-1.1774, lo)).toBe('0'); // clamped up to min
    const hi = parseDistribution({
      distribution: 'exponential',
      rate: '1',
      max: '0.5',
      decimals: '3',
    });
    expect(formatSample(0.6931, hi)).toBe('0.500'); // clamped down to max
  });
});

describe('parseDistribution — validation', () => {
  it('rejects an unknown distribution name', () => {
    expect(() => parseDistribution({ distribution: 'weird' })).toThrow(/distribution/i);
  });

  it('requires the distribution-specific parameters', () => {
    expect(() => parseDistribution({ distribution: 'normal', mean: '0' })).toThrow(/sd/);
    expect(() => parseDistribution({ distribution: 'lognormal', meanlog: '0' })).toThrow(/sdlog/);
    expect(() => parseDistribution({ distribution: 'exponential' })).toThrow(/rate/);
    expect(() => parseDistribution({ distribution: 'pareto', alpha: '2' })).toThrow(/xmin/);
  });

  it('rejects non-positive scale parameters', () => {
    expect(() => parseDistribution({ distribution: 'normal', mean: '0', sd: '0' })).toThrow(/sd/);
    expect(() => parseDistribution({ distribution: 'exponential', rate: '0' })).toThrow(/rate/);
    expect(() => parseDistribution({ distribution: 'pareto', alpha: '0', xmin: '1' })).toThrow(
      /alpha/,
    );
  });

  it('rejects decimals<0 and min>max', () => {
    expect(() =>
      parseDistribution({ distribution: 'normal', mean: '0', sd: '1', decimals: '-1' }),
    ).toThrow(/decimals/);
    expect(() =>
      parseDistribution({ distribution: 'normal', mean: '0', sd: '1', min: '10', max: '5' }),
    ).toThrow(/min/);
  });
});
