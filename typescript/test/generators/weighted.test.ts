/**
 * Reading weights out of a CSV.
 *
 * The point of the feature is that proportions come from the DATA, so the
 * assertions here are about faithfulness to the file — including the rows a
 * naive reader would silently mishandle: zero weights, a missing column, and a
 * weight column that is really the value column.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WeightedFileError,
  loadWeightedValues,
  weightColumnOf,
} from '../../src/generators/weighted.js';

let dir = '';
const file = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdc-weighted-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('weightColumnOf', () => {
  it('is absent unless the attribute carries something', () => {
    expect(weightColumnOf({})).toBeUndefined();
    expect(weightColumnOf({ weight: '   ' })).toBeUndefined();
    expect(weightColumnOf({ weight: 'count' })).toBe('count');
    expect(weightColumnOf({ weight: ' 2 ' })).toBe('2');
  });
});

describe('loadWeightedValues', () => {
  it('turns raw counts into percents that sum to 100', () => {
    const path = file('names.csv', 'name,count\nBob,20000\nJack,10000\n');
    const { values, percents } = loadWeightedValues(path, { column: 'name' }, 'count');
    expect(values).toEqual(['Bob', 'Jack']);
    // Bob is twice Jack — the exact claim the feature makes.
    expect(percents[0]).toBeCloseTo(66.666, 2);
    expect(percents[1]).toBeCloseTo(33.333, 2);
    expect(percents.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  it('addresses the weight column by index too', () => {
    const path = file('idx.csv', 'Bob,20000\nJack,10000\n');
    const { values, percents } = loadWeightedValues(path, { column: '1' }, '2');
    expect(values).toEqual(['Bob', 'Jack']);
    expect(percents[0]).toBeCloseTo(66.666, 2);
  });

  it('drops rows whose weight is zero rather than carrying them', () => {
    // A value that can never be drawn only costs the distribution memory, and
    // census files are full of them.
    const path = file('zero.csv', 'name,count\nBob,10\nGhost,0\nJack,10\n');
    expect(loadWeightedValues(path, { column: 'name' }, 'count').values).toEqual(['Bob', 'Jack']);
  });

  it('refuses a weight that is not a non-negative number', () => {
    const bad = file('bad.csv', 'name,count\nBob,many\n');
    expect(() => loadWeightedValues(bad, { column: 'name' }, 'count')).toThrow(WeightedFileError);
    const neg = file('neg.csv', 'name,count\nBob,-5\n');
    expect(() => loadWeightedValues(neg, { column: 'name' }, 'count')).toThrow(/non-negative/);
  });

  it('refuses pointing the weight at the value column', () => {
    const path = file('same.csv', 'name,count\nBob,10\n');
    expect(() => loadWeightedValues(path, { column: 'name' }, 'name')).toThrow(/same column/);
  });

  it('refuses a file where nothing has a positive weight', () => {
    const path = file('allzero.csv', 'name,count\nBob,0\nJack,0\n');
    expect(() => loadWeightedValues(path, { column: 'name' }, 'count')).toThrow(/positive weight/);
  });

  // `Number('')` is 0, so a blank cell would otherwise be indistinguishable
  // from a deliberate zero and the value would disappear from the run without
  // a word. Real exports have blanks; a vanished row is found weeks later.
  it('refuses a blank weight instead of reading it as zero', () => {
    const path = file('blank.csv', 'name,count\nBob,10\nTowel,\nJack,10\n');
    expect(() => loadWeightedValues(path, { column: 'name' }, 'count')).toThrow(
      /empty for value "Towel"/,
    );
  });

  it('still accepts an explicit zero as "exclude this"', () => {
    const path = file('explicit-zero.csv', 'name,count\nBob,10\nGhost,0\n');
    const { values } = loadWeightedValues(path, { column: 'name' }, 'count');
    expect(values).toEqual(['Bob']);
  });

  it('handles a long tail without losing the total', () => {
    const rows = ['name,count', 'Smith,2500000'];
    for (let i = 0; i < 5000; i++) rows.push(`Rare${String(i)},1`);
    const path = file('tail.csv', rows.join('\n') + '\n');
    const { values, percents } = loadWeightedValues(path, { column: 'name' }, 'count');
    expect(values).toHaveLength(5001);
    expect(percents.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(percents[0]).toBeGreaterThan(99);
  });
});
