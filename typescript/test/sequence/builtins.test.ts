import { describe, expect, it } from 'vitest';

import { createPrng } from '../../src/prng/prng.js';
import { buildSequences } from '../../src/sequence/build.js';

describe('built-in sequences — _count, _first, _last, _total', () => {
  it('_count is 1-based over [1..count]', () => {
    const reg = buildSequences([], 5, createPrng('x'), 'en', 0);
    expect(reg['_count']?.values).toEqual(['1', '2', '3', '4', '5']);
  });

  it('_first is "true" only on iteration 0, "false" elsewhere', () => {
    const reg = buildSequences([], 4, createPrng('x'), 'en', 0);
    expect(reg['_first']?.values).toEqual(['true', 'false', 'false', 'false']);
  });

  it('_last is "true" only on the final iteration, "false" elsewhere', () => {
    const reg = buildSequences([], 4, createPrng('x'), 'en', 0);
    expect(reg['_last']?.values).toEqual(['false', 'false', 'false', 'true']);
  });

  it('_total is the total count repeated on every row', () => {
    const reg = buildSequences([], 4, createPrng('x'), 'en', 0);
    expect(reg['_total']?.values).toEqual(['4', '4', '4', '4']);
  });

  it('single-row case has _first and _last both "true"', () => {
    const reg = buildSequences([], 1, createPrng('x'), 'en', 0);
    expect(reg['_first']?.values).toEqual(['true']);
    expect(reg['_last']?.values).toEqual(['true']);
    expect(reg['_total']?.values).toEqual(['1']);
  });

  it('user sequences can coexist with the built-ins', () => {
    const reg = buildSequences(
      [
        {
          name: 'X',
          gen: { type: 'text', attrs: { type: 'text', value: 'a,b' } },
        },
      ],
      3,
      createPrng('y'),
      'en',
      0,
    );
    expect(reg['_count']).toBeDefined();
    expect(reg['_first']).toBeDefined();
    expect(reg['_last']).toBeDefined();
    expect(reg['_total']).toBeDefined();
    expect(reg['X']).toBeDefined();
    expect(reg['X']?.values).toHaveLength(3);
  });
});
