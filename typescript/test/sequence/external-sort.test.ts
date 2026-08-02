import { describe, expect, it } from 'vitest';

import { externalSort } from '../../src/sequence/external-sort.js';

const sorted = (input: readonly string[], opts?: Parameters<typeof externalSort>[1]): string[] => [
  ...externalSort(input, opts),
];

describe('externalSort', () => {
  it('sorts correctly when the input spans many disk runs (chunkSize ≪ input)', () => {
    // 500 records, chunk of 7 → ~72 runs merged. Forces the disk path + merge.
    const input = Array.from({ length: 500 }, (_, i) => String((i * 137 + 11) % 500));
    const out = sorted(input, { chunkSize: 7 });
    expect(out).toEqual([...input].sort()); // byte order, matches Array.sort default
    expect(out).toHaveLength(input.length); // no records lost or duplicated
  });

  it('is a permutation of the input (keeps duplicates)', () => {
    const input = ['b', 'a', 'b', 'c', 'a', 'a'];
    expect(sorted(input, { chunkSize: 2 })).toEqual(['a', 'a', 'a', 'b', 'b', 'c']);
  });

  it('uses the in-memory path when everything fits in one chunk', () => {
    const input = ['3', '1', '2'];
    expect(sorted(input, { chunkSize: 1000 })).toEqual(['1', '2', '3']);
  });

  it('honors a custom comparator (numeric, not byte order)', () => {
    const input = ['10', '9', '100', '2', '30'];
    const numeric = (a: string, b: string): number => Number(a) - Number(b);
    expect(sorted(input, { chunkSize: 2, compare: numeric })).toEqual([
      '2',
      '9',
      '10',
      '30',
      '100',
    ]);
    // byte order would put "100" and "10" before "2"
    expect(sorted(input, { chunkSize: 2 })).toEqual(['10', '100', '2', '30', '9']);
  });

  it('handles empty input', () => {
    expect(sorted([], { chunkSize: 4 })).toEqual([]);
  });

  it('is deterministic across runs', () => {
    const input = Array.from({ length: 200 }, (_, i) => String((i * 977) % 251));
    expect(sorted(input, { chunkSize: 5 })).toEqual(sorted(input, { chunkSize: 5 }));
    expect(sorted(input, { chunkSize: 5 })).toEqual(sorted(input, { chunkSize: 50 })); // chunk size can't change the result
  });
});
