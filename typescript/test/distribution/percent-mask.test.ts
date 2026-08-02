import { describe, expect, it } from 'vitest';

import { PercentMaskError, expandPercentMask } from '../../src/distribution/index.js';

describe('expandPercentMask', () => {
  it('keeps full percent lists unchanged', () => {
    expect(expandPercentMask('42,58', 2)).toEqual([42, 58]);
  });

  it('fills a missing trailing value from the remainder', () => {
    expect(expandPercentMask('42', 2)).toEqual([42, 58]);
  });

  it('fills a missing leading value from the remainder', () => {
    expect(expandPercentMask(',58', 2)).toEqual([42, 58]);
  });

  it('left-pads leading masks when fewer entries than values are provided', () => {
    expect(expandPercentMask(',10,10', 4)).toEqual([40, 40, 10, 10]);
  });

  it('splits middle and edge gaps equally', () => {
    expect(expandPercentMask(',,25,,', 5)).toEqual([18.75, 18.75, 25, 18.75, 18.75]);
  });

  it('right-pads trailing masks when fewer entries than values are provided', () => {
    expect(expandPercentMask('46,', 5)).toEqual([46, 13.5, 13.5, 13.5, 13.5]);
  });

  it('allows zero remainder for omitted values', () => {
    expect(expandPercentMask('50,50', 3)).toEqual([50, 50, 0]);
  });

  it('rejects masks with more entries than values', () => {
    expect(() => expandPercentMask('10,20,70', 2)).toThrow(PercentMaskError);
    try {
      expandPercentMask('10,20,70', 2);
    } catch (err) {
      expect(err).toBeInstanceOf(PercentMaskError);
      expect((err as PercentMaskError).kind).toBe('length');
    }
  });

  it('rejects non-numeric filled positions', () => {
    expect(() => expandPercentMask('10,nope,', 3)).toThrow(/non-numeric/);
  });

  it('rejects fixed positions that exceed 100', () => {
    expect(() => expandPercentMask('60,50,', 3)).toThrow(/expected <= 100/);
  });

  it('rejects complete masks that do not sum to 100', () => {
    expect(() => expandPercentMask('30,40', 2)).toThrow(/expected 100/);
  });
});
