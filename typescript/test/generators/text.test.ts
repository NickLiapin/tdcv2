import { describe, expect, it } from 'vitest';

import { textUniform, textWithPercents } from '../../src/generators/text.js';
import { createPrng } from '../../src/prng/prng.js';

describe('textWithPercents generator', () => {
  it('returns exactly `count` cells', () => {
    const gen = textWithPercents(['a', 'b'], [60, 40]);
    const out = gen(100, createPrng('x'));
    expect(out).toHaveLength(100);
  });

  it('respects the exact percent distribution', () => {
    const gen = textWithPercents(['M', 'W'], [42, 58]);
    const out = gen(100, createPrng('674teyer74yTRGY7'));
    expect(out.filter((v) => v === 'M')).toHaveLength(42);
    expect(out.filter((v) => v === 'W')).toHaveLength(58);
  });

  it('is deterministic for the same seed', () => {
    const a = textWithPercents(['a', 'b', 'c'], [30, 50, 20])(10, createPrng('same'));
    const b = textWithPercents(['a', 'b', 'c'], [30, 50, 20])(10, createPrng('same'));
    expect(a).toEqual(b);
  });

  it('matches golden vector for ([X,Y,Z], [30,50,20], count=10, seed=674teyer74yTRGY7)', () => {
    const gen = textWithPercents(['X', 'Y', 'Z'], [30, 50, 20]);
    const out = gen(10, createPrng('674teyer74yTRGY7'));
    expect(out).toEqual(['Y', 'X', 'X', 'Z', 'Z', 'Y', 'Y', 'Y', 'X', 'Y']);
  });
});

describe('textUniform generator', () => {
  it('returns exactly `count` cells', () => {
    const gen = textUniform(['a', 'b', 'c']);
    const out = gen(50, createPrng('u'));
    expect(out).toHaveLength(50);
  });

  it('every output value is drawn from the input set', () => {
    const values = ['alpha', 'beta', 'gamma'];
    const gen = textUniform(values);
    const out = gen(200, createPrng('uniform-seed'));
    for (const v of out) expect(values).toContain(v);
  });

  it('is deterministic for the same seed', () => {
    const a = textUniform(['a', 'b', 'c', 'd'])(20, createPrng('same'));
    const b = textUniform(['a', 'b', 'c', 'd'])(20, createPrng('same'));
    expect(a).toEqual(b);
  });

  it('matches golden vector for (["a","b","c","d","e"], count=5, seed=hello)', () => {
    // Reference: randomDataFromArray sequence in the 2022-2024 prototype.
    const gen = textUniform(['a', 'b', 'c', 'd', 'e']);
    const out = gen(5, createPrng('hello'));
    expect(out).toEqual(['e', 'd', 'e', 'd', 'e']);
  });
});
