/**
 * The small pure helpers the national-ID presets are built out of.
 *
 * A pack that computes a check digit is only as trustworthy as these: get
 * `luhnCheckDigit` wrong by one and every card number a config generates fails
 * against the real algorithm while looking perfectly plausible. So the vectors
 * below are real ones, not values read back off this implementation.
 */

import { describe, expect, it } from 'vitest';

import {
  allSame,
  groupEvery,
  groupFromRight,
  luhnCheckDigit,
  randomChars,
  randomDigits,
  randomNonRepeatedDigits,
  weightedSum,
} from '../../src/presets/utils.js';
import { createPrng } from '../../src/prng/prng.js';

describe('luhnCheckDigit', () => {
  // Published test numbers. The first is the one Luhn's own patent example
  // ends on; the others are the card-brand test numbers every payment
  // gateway documents, with their final digit removed.
  it.each([
    ['79927398713', '7992739871'],
    ['4111111111111111', '411111111111111'],
    ['5500005555555559', '550000555555555'],
    ['378282246310005', '37828224631000'],
    ['6011111111111117', '601111111111111'],
  ])('completes %s', (whole, payload) => {
    expect(luhnCheckDigit(payload)).toBe(Number(whole.at(-1)));
  });

  it('is 0 when the payload already sums to a multiple of ten', () => {
    // The modulo has to come back as 0 rather than 10 — the classic slip.
    expect(luhnCheckDigit('0')).toBe(0);
  });
});

describe('weightedSum', () => {
  it('multiplies digit by weight, position for position', () => {
    expect(weightedSum('123', [1, 2, 3])).toBe(1 + 4 + 9);
  });

  it('treats a missing weight as zero rather than as NaN', () => {
    // A source longer than its weight table is the shape that produced NaN,
    // and NaN spreads: one of them makes the whole identifier unusable.
    expect(weightedSum('1234', [1, 1])).toBe(3); // 1·1 + 2·1, then nothing
  });

  it('is zero for an empty source', () => {
    expect(weightedSum('', [5, 5])).toBe(0);
  });
});

describe('groupEvery', () => {
  it('cuts from the LEFT, so a short group lands at the end', () => {
    expect(groupEvery('GB82WEST12345698765432', 4, ' ')).toBe('GB82 WEST 1234 5698 7654 32');
  });

  it('leaves a value shorter than one group alone', () => {
    expect(groupEvery('12', 4, ' ')).toBe('12');
    expect(groupEvery('', 4, ' ')).toBe('');
  });
});

describe('groupFromRight', () => {
  it('cuts from the RIGHT, so a short group lands at the front', () => {
    // Which is what money and phone numbers want: 1 234 567, never 123 456 7.
    expect(groupFromRight('1234567', 3, ' ')).toBe('1 234 567');
  });

  it('produces no leading delimiter when the length divides evenly', () => {
    expect(groupFromRight('123456', 3, ' ')).toBe('123 456');
  });

  it('leaves an empty value empty rather than emitting a bare delimiter', () => {
    expect(groupFromRight('', 3, ' ')).toBe('');
  });
});

describe('allSame', () => {
  it('is true for one repeated character, and for nothing', () => {
    expect(allSame('7777')).toBe(true);
    expect(allSame('7')).toBe(true);
    expect(allSame('')).toBe(true);
  });

  it('is false as soon as one character differs', () => {
    expect(allSame('7776')).toBe(false);
  });
});

describe('randomDigits', () => {
  it('returns exactly the length asked for, digits only', () => {
    const value = randomDigits(createPrng('digits'), 12);
    expect(value).toHaveLength(12);
    expect(value).toMatch(/^[0-9]{12}$/);
  });

  it('is reproducible from a seed, which is the whole promise', () => {
    expect(randomDigits(createPrng('same'), 20)).toBe(randomDigits(createPrng('same'), 20));
  });

  it('returns nothing for a length of zero', () => {
    expect(randomDigits(createPrng('zero'), 0)).toBe('');
  });
});

describe('randomNonRepeatedDigits', () => {
  it('never returns a run of one repeated digit', () => {
    for (let i = 0; i < 200; i++) {
      expect(allSame(randomNonRepeatedDigits(createPrng(`seed-${String(i)}`), 4))).toBe(false);
    }
  });

  it('falls back to 1000… when the draw cannot help — a length of one', () => {
    // Every single digit repeats itself, so the retry loop can never succeed
    // and the escape hatch is the only way out. Without it this would spin a
    // hundred times and then hand back a value that IS all the same.
    expect(randomNonRepeatedDigits(createPrng('one'), 1)).toBe('1');
    expect(randomNonRepeatedDigits(createPrng('four'), 4)).toMatch(/^[0-9]{4}$/);
  });
});

describe('randomChars', () => {
  it('draws from the alphabet it was given, and no further', () => {
    const value = randomChars(createPrng('abc'), 'abc', 30);
    expect(value).toHaveLength(30);
    expect(value).toMatch(/^[abc]{30}$/);
  });

  it('counts a code point as one character, not two', () => {
    // An emoji is a surrogate PAIR in JavaScript. Sliced by UTF-16 unit it
    // comes back as half a character, which renders as a replacement box.
    const value = randomChars(createPrng('emoji'), '🙂🙃', 5);
    // Spreading a string is exactly what is under test here: it yields CODE
    // POINTS, and the count has to be 5 of them rather than 10 UTF-16 units.
    /* eslint-disable @typescript-eslint/no-misused-spread */
    expect([...value]).toHaveLength(5);
    expect([...value].every((c) => c === '🙂' || c === '🙃')).toBe(true);
    /* eslint-enable @typescript-eslint/no-misused-spread */
  });

  it('returns nothing when the alphabet is empty', () => {
    expect(randomChars(createPrng('none'), '', 5)).toBe('');
  });
});
