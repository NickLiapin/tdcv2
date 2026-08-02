/**
 * The `compact` filter — a whole number in a shorter alphabet.
 *
 * It exists so a unique suffix stays readable at scale: appending a row id to a
 * generated email keeps the address unique, but `john.smith2000000000@` is
 * nobody's address. In base 36 that id is `x2qxvk`.
 *
 * The property that must never break is that the mapping stays ONE-TO-ONE — a
 * shorter suffix is worthless if it can collide, since collision is the exact
 * thing it was added to prevent.
 */

import { describe, expect, it } from 'vitest';

import { applyCompact } from '../../src/format/transforms.js';

describe('applyCompact', () => {
  it('shortens a large number', () => {
    expect(applyCompact('1000000', 36)).toBe('lfls');
    expect(applyCompact('2000000000', 36)).toBe('x2qxvk'); // 10 digits → 6
  });

  it('leaves small numbers recognisable', () => {
    expect(applyCompact('1', 36)).toBe('1');
    expect(applyCompact('9', 36)).toBe('9');
    expect(applyCompact('35', 36)).toBe('z');
    expect(applyCompact('36', 36)).toBe('10');
  });

  it('is one-to-one — the whole point', () => {
    // A shorter suffix that could collide would be worse than the long one.
    const seen = new Set<string>();
    for (let n = 0; n < 20000; n++) {
      const out = applyCompact(String(n), 36);
      expect(seen.has(out), `${String(n)} collided as ${out}`).toBe(false);
      seen.add(out);
    }
  });

  it('emits LOWERCASE only', () => {
    // Base 62 would be shorter, but many systems fold an address's local part
    // to lower case — "aB" and "Ab" would merge and silently reintroduce the
    // duplicates this exists to prevent.
    for (let n = 0; n < 5000; n += 7) {
      const out = applyCompact(String(n), 36);
      expect(out, String(n)).toBe(out.toLowerCase());
    }
  });

  it('honours an explicit base', () => {
    expect(applyCompact('255', 16)).toBe('ff');
    expect(applyCompact('5', 2)).toBe('101');
  });

  it('passes through anything that is not a whole number', () => {
    // Filters are lenient here; the validator is where a mistake gets named.
    expect(applyCompact('hello', 36)).toBe('hello');
    expect(applyCompact('1.5', 36)).toBe('1.5');
    expect(applyCompact('', 36)).toBe('');
  });

  it('passes through on a nonsensical base rather than producing garbage', () => {
    expect(applyCompact('100', 1)).toBe('100');
    expect(applyCompact('100', 99)).toBe('100');
  });

  it('keeps a negative sign', () => {
    expect(applyCompact('-1000000', 36)).toBe('-lfls');
  });

  it('refuses to mangle a number too large to be exact', () => {
    // Beyond 2^53 a JS number cannot represent every integer, so converting
    // would quietly map different ids onto the same text.
    expect(applyCompact('9007199254740993', 36)).toBe('9007199254740993');
  });
});
