/**
 * Sizes people can read.
 *
 * The bug this replaces: `pack list` divided by 1,048,576 and printed one
 * decimal, so a 3 KB pack and a 9 KB pack both read `0.0 MB` and the whole
 * catalogue looked like it weighed nothing. These cases pin the boundaries,
 * and the shared CLI fixture pins that all five implementations agree.
 */

import { describe, expect, it } from 'vitest';

import { humanBytes } from '../src/human-bytes.js';

describe('humanBytes', () => {
  it('says bytes in bytes rather than a fraction of a kilobyte', () => {
    // The case that started this: below a kilobyte there IS no sensible
    // fraction, so the unit has to change instead of the precision.
    expect(humanBytes(1)).toBe('1 B');
    expect(humanBytes(800)).toBe('800 B');
    expect(humanBytes(1023)).toBe('1023 B');
  });

  it('never prints 0.0 of anything for a file that exists', () => {
    for (const n of [1, 9, 99, 512, 1024, 2710, 9999]) {
      expect(humanBytes(n).startsWith('0.0')).toBe(false);
    }
  });

  it('keeps a decimal below a hundred, where it distinguishes two packs', () => {
    expect(humanBytes(1024)).toBe('1.0 KB');
    expect(humanBytes(2710)).toBe('2.6 KB'); // the smallest shipped pack
    expect(humanBytes(10_240)).toBe('10.0 KB');
    expect(humanBytes(99_000)).toBe('96.7 KB');
  });

  it('drops the decimal at a hundred, where it is noise', () => {
    expect(humanBytes(102_400)).toBe('100 KB');
    expect(humanBytes(253_515)).toBe('248 KB'); // the largest shipped pack
  });

  it('climbs a unit when it should', () => {
    expect(humanBytes(1_048_576)).toBe('1.0 MB');
    expect(humanBytes(1_572_864)).toBe('1.5 MB');
    expect(humanBytes(1_073_741_824)).toBe('1.0 GB');
    expect(humanBytes(34_359_738_368)).toBe('32.0 GB');
    expect(humanBytes(1_099_511_627_776)).toBe('1.0 TB');
  });

  it('promotes rather than printing 1024 of a unit', () => {
    // 1023.999 KB rounds to a whole 1024 KB, which nobody writes.
    expect(humanBytes(1_073_741_823)).toBe('1.0 GB');
    expect(humanBytes(1_048_575)).toBe('1.0 MB');
  });

  it('answers a nonsense number instead of throwing at it', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(-1)).toBe('0 B');
    expect(humanBytes(Number.NaN)).toBe('0 B');
  });
});
