/**
 * How a Parquet run is divided — the half of the plan nothing had ever asked about.
 *
 * `partitionGroups` and `parquetJobLimit` came out of `parquet-parallel.ts`, a file that reads 3%
 * because the only thing that exercises it is an end-to-end test running the built CLI as a child
 * process, which the coverage instrument cannot see. That was fine for the thread-spawning half.
 * It was not fine for these two: they are arithmetic, they decide how a file is cut up, and they
 * had no test at all — the 3% hid that as thoroughly as it hid everything else.
 *
 * The row-range half (`partitionRows`, `resolveJobCount`, `parallelBlockReason`) was already
 * tested and those cases live on in `parallel.test.ts`, now pointed at the same module.
 */

import { describe, expect, it } from 'vitest';

import { partitionGroups, parquetJobLimit } from '../../src/cli/parallel-plan.js';

const SOURCE =
  '<tdc><env count="20" seed="pp" inject="${{%}}"><sequence name="Id">' +
  '<gen type="increment" value="1"/></sequence></env>' +
  '<block><line><data name="id">${{Id}}</data></line></block></tdc>';

const NOW = Date.parse('2026-04-23T12:00:00Z');

describe('partitionGroups', () => {
  it('covers every group exactly once, in order, with no gap', () => {
    for (const [groups, jobs] of [
      [10, 3],
      [10, 1],
      [7, 7],
      [100, 8],
      [1, 4],
    ] as const) {
      const ranges = partitionGroups(groups, jobs);
      expect(ranges[0]?.[0], `${String(groups)}/${String(jobs)} starts at 0`).toBe(0);
      expect(
        ranges[ranges.length - 1]?.[1],
        `${String(groups)}/${String(jobs)} ends at ${String(groups)}`,
      ).toBe(groups);
      for (let i = 1; i < ranges.length; i++) {
        // A gap loses row groups from the file; an overlap writes them twice.
        expect(ranges[i]?.[0], `${String(groups)}/${String(jobs)} is contiguous`).toBe(
          ranges[i - 1]?.[1],
        );
      }
    }
  });

  it('spreads the remainder one group at a time, to the earliest workers', () => {
    // 10 across 3: 4/3/3, not 4/4/2 — the widest range is what decides how long the run takes.
    expect(partitionGroups(10, 3)).toEqual([
      [0, 4],
      [4, 7],
      [7, 10],
    ]);
  });

  it('never makes more ranges than there are groups', () => {
    // A worker with no groups is a thread that costs and produces nothing.
    expect(partitionGroups(3, 12)).toHaveLength(3);
    expect(partitionGroups(1, 8)).toEqual([[0, 1]]);
  });

  it('a file with no groups still yields one range rather than none', () => {
    // The caller writes a footer whatever happens; zero ranges would write no file at all.
    expect(partitionGroups(0, 4)).toEqual([[0, 0]]);
  });

  it('a nonsensical job count is clamped, not obeyed', () => {
    expect(partitionGroups(6, 0)).toEqual([[0, 6]]);
    expect(partitionGroups(6, -3)).toEqual([[0, 6]]);
  });
});

describe('parquetJobLimit', () => {
  it('never asks for more workers than the file has row groups', () => {
    // The count is decided by the config, so the answer is a property of the file, not the flag.
    const groups = parquetJobLimit(SOURCE, 1000, NOW, 'pp');
    expect(groups).toBeGreaterThanOrEqual(1);
    expect(parquetJobLimit(SOURCE, 1000, NOW, 'pp')).toBe(groups);
    // Asking for fewer than the file allows is honoured — the user's number wins downwards.
    expect(parquetJobLimit(SOURCE, 1, NOW, 'pp')).toBe(1);
  });

  it('always returns at least one, whatever it is handed', () => {
    for (const jobs of [0, -1, -100]) {
      expect(parquetJobLimit(SOURCE, jobs, NOW, 'pp'), `jobs=${String(jobs)}`).toBe(1);
    }
  });
});
