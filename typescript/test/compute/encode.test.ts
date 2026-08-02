import { describe, expect, it } from 'vitest';

import { codePointOf, encodeChar } from '../../src/compute/encode.js';
import { ComputeError } from '../../src/compute/value.js';

describe('codePointOf', () => {
  it('returns the code point of a single character', () => {
    expect(codePointOf('A')).toBe(65);
    expect(codePointOf('0')).toBe(48);
  });

  it('handles an astral (beyond-BMP) code point as one character', () => {
    expect(codePointOf('😀')).toBe(0x1f600);
  });

  it('throws on empty or multi-character input', () => {
    expect(() => codePointOf('')).toThrow(ComputeError);
    expect(() => codePointOf('AB')).toThrow(/single character/);
  });
});

describe('encodeChar base36', () => {
  it('maps digits to themselves', () => {
    expect(encodeChar('0', 'base36')).toBe('0');
    expect(encodeChar('9', 'base36')).toBe('9');
  });

  it('maps letters to 10..35, case-insensitively', () => {
    expect(encodeChar('A', 'base36')).toBe('10');
    expect(encodeChar('a', 'base36')).toBe('10');
    expect(encodeChar('D', 'base36')).toBe('13');
    expect(encodeChar('Z', 'base36')).toBe('35');
  });

  it('throws on a non-alphanumeric character', () => {
    expect(() => encodeChar('-', 'base36')).toThrow(/not a digit or letter/);
  });
});

describe('encodeChar ascii / unicode', () => {
  it('ascii returns the decimal code for ASCII characters', () => {
    expect(encodeChar('A', 'ascii')).toBe('65');
    expect(encodeChar(' ', 'ascii')).toBe('32');
  });

  it('ascii rejects code points >= 128', () => {
    expect(() => encodeChar('é', 'ascii')).toThrow(/not an ASCII/);
  });

  it('unicode returns the decimal code point, including beyond ASCII', () => {
    expect(encodeChar('A', 'unicode')).toBe('65');
    expect(encodeChar('é', 'unicode')).toBe('233');
  });
});

describe('encodeChar hex / binary / octal', () => {
  it('renders the code point in the requested base (lowercase)', () => {
    expect(encodeChar('A', 'hex')).toBe('41');
    expect(encodeChar('A', 'binary')).toBe('1000001');
    expect(encodeChar('A', 'octal')).toBe('101');
  });
});

describe('encodeChar errors', () => {
  it('throws on an unknown encoding', () => {
    expect(() => encodeChar('A', 'base58')).toThrow(/unknown encoding/);
  });
});
