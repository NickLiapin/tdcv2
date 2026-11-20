import { describe, expect, it } from 'vitest';

import {
  httpInputWindows,
  lazy,
  rememberLastRow,
  rememberRows,
} from '../../src/sequence/stream-lazy.js';
import type { SequenceSpec } from '../../src/sequence/types.js';

/** A column that counts how often each row is drawn. */
function counted(): { draws: Map<number, number>; resolve: (i: number) => string } {
  const draws = new Map<number, number>();
  return {
    draws,
    resolve: (i) => {
      draws.set(i, (draws.get(i) ?? 0) + 1);
      return `v${String(i)}`;
    },
  };
}

describe('rememberLastRow', () => {
  it('answers a second read of the same row without drawing it again', () => {
    const column = counted();
    const seq = rememberLastRow(lazy('Hash', column.resolve));
    expect(seq.resolve?.(7)).toBe('v7');
    expect(seq.resolve?.(7)).toBe('v7');
    expect(column.draws.get(7)).toBe(1);
  });
});

describe('rememberRows — the input column of an http batch', () => {
  it('draws each row once when a batch reads ahead and the line follows', () => {
    // The shape of a run: the batch reads its input rows 0..9 before the line gets there, then
    // the line reads them one by one, then the next batch reads 10..19.
    const column = counted();
    const seq = rememberRows(lazy('Pass', column.resolve), 10 * 3);
    for (let batch = 0; batch < 5; batch++) {
      for (let i = batch * 10; i < batch * 10 + 10; i++) seq.resolve?.(i);
      for (let i = batch * 10; i < batch * 10 + 10; i++)
        expect(seq.resolve?.(i)).toBe(`v${String(i)}`);
    }
    expect([...column.draws.values()].every((n) => n === 1)).toBe(true);
  });

  it('never answers a row with another row that shares its slot', () => {
    const column = counted();
    const seq = rememberRows(lazy('Pass', column.resolve), 4);
    expect(seq.resolve?.(1)).toBe('v1');
    expect(seq.resolve?.(5)).toBe('v5');
    expect(seq.resolve?.(1)).toBe('v1');
    expect(column.draws.get(1)).toBe(2);
  });
});

describe('httpInputWindows', () => {
  it('finds an http in= wherever it sits and keeps the widest window', () => {
    const specs = [
      { name: 'Pass', gen: { type: 'regex', attrs: { value: '[a-z]{8}' } } },
      { name: 'Hash', gen: { type: 'http', attrs: { src: 'http://x/', in: 'Pass' } } },
      {
        name: 'Sig',
        mix: {
          attrs: {},
          cases: [
            {
              attrs: {},
              parts: [
                {
                  gen: {
                    type: 'http',
                    attrs: { src: 'http://y/', in: 'Pass', batch: '500', parallel: '4' },
                  },
                },
              ],
            },
          ],
        },
      },
      { name: 'Plain', gen: { type: 'http', attrs: { src: 'http://z/' } } },
    ] as unknown as SequenceSpec[];
    // 10,000 × (1 + 2) against 500 × (4 + 2): the default batch wins.
    expect([...httpInputWindows(specs)]).toEqual([['Pass', 30_000]]);
  });
});
