/**
 * Fitting the worker count to the machine.
 *
 * Each worker is its own isolate and re-parses the config's data files, so
 * memory grows linearly with the job count while the wall clock often does not:
 * measured on a 160 000-row surname CSV, one worker took 170 MB and eight took
 * 1057 MB, both finishing in 0.6 s. The point of this module is to stop the
 * tool putting itself somewhere it dies halfway — silently, because someone
 * generating data may be an analyst rather than an engineer.
 *
 * RAM is passed in rather than read from the machine, so the interesting cases
 * (a small laptop, a big data file) can actually be tested.
 */

import { describe, expect, it } from 'vitest';

import { declaredSources, fitJobsToMemory } from '../../src/cli/memory-budget.js';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe('fitJobsToMemory', () => {
  it('leaves a comfortable run alone', () => {
    // Small file, plenty of RAM — no reason to interfere.
    const out = fitJobsToMemory({ jobs: 7, dataBytes: 1 * MB, totalBytes: 32 * GB });
    expect(out.jobs).toBe(7);
    expect(out.reduced).toBe(false);
  });

  it('cuts the workers when the data would be copied into each one', () => {
    // 50 MB of CSV becomes ~2.5 GB parsed per worker; eight of those do not fit
    // in 8 GB.
    const out = fitJobsToMemory({ jobs: 8, dataBytes: 50 * MB, totalBytes: 8 * GB });
    expect(out.jobs).toBeLessThan(8);
    expect(out.reduced).toBe(true);
  });

  it('still runs — never returns zero workers', () => {
    // Even an absurd file must produce a run, just a slow single-threaded one.
    // Refusing outright would be less useful than being slow.
    const out = fitJobsToMemory({ jobs: 8, dataBytes: 2000 * MB, totalBytes: 2 * GB });
    expect(out.jobs).toBe(1);
    expect(out.reduced).toBe(true);
  });

  it('scales with the machine, not with a fixed guess', () => {
    const small = fitJobsToMemory({ jobs: 16, dataBytes: 20 * MB, totalBytes: 4 * GB });
    const large = fitJobsToMemory({ jobs: 16, dataBytes: 20 * MB, totalBytes: 64 * GB });
    expect(small.jobs).toBeLessThan(large.jobs);
  });

  it('never touches a single-threaded run', () => {
    const out = fitJobsToMemory({ jobs: 1, dataBytes: 5000 * MB, totalBytes: 1 * GB });
    expect(out.jobs).toBe(1);
    expect(out.reduced).toBe(false);
  });

  it('is conservative rather than optimistic', () => {
    // The measured cost of eight workers on the 2.2 MB surname file was
    // ~1057 MB; the estimate must not come out BELOW what really happens, or
    // the guard would let through exactly the run it exists to prevent.
    const out = fitJobsToMemory({ jobs: 8, dataBytes: 2.2 * MB, totalBytes: 2 * GB });
    // 2 GB machine, 8 workers of ~230 MB = 1.8 GB — more than half of RAM.
    expect(out.jobs).toBeLessThan(8);
  });
});

describe('declaredSources', () => {
  it('finds every src= in the config', () => {
    const src =
      '<gen type="file" src="names.csv"/><gen type="file" src=" cities.csv "/>' +
      '<gen type="pattern" src="curve.svg"/>';
    expect(declaredSources(src)).toEqual(['names.csv', 'cities.csv', 'curve.svg']);
  });

  it('ignores an empty one', () => {
    expect(declaredSources('<gen src=""/>')).toEqual([]);
  });

  it('returns nothing for a config that reads no files', () => {
    expect(declaredSources('<gen type="number" value="1..9"/>')).toEqual([]);
  });
});
