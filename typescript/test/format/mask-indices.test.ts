import { describe, expect, it } from 'vitest';

import { applyMask } from '../../src/format/transforms.js';

/**
 * Positional indices in a mask — see
 * docs/specs/2026-07-23-mask-positional-reordering.md.
 *
 * The rules being pinned here: an index addresses the ORIGINAL input (0-based,
 * negative from the end, `a..b` inclusive) and removes that position from the
 * pool; bare `x`/`w` take what is left, in original order; `*` is the leftovers.
 * Emission and consumption are two channels that do not interfere, which is why
 * the same notation reads as a move or as a copy depending on the rest of the
 * mask.
 */
describe('mask indices', () => {
  describe('reordering — the case with no alternative', () => {
    it('swaps two words regardless of their length', () => {
      expect(applyMask('w[1]::w[0]', 'John Smith')).toBe('Smith::John');
      // `slice` cannot do this one: the words have different lengths.
      expect(applyMask('w[1]::w[0]', 'Peter Clark')).toBe('Clark::Peter');
    });

    it('puts the last word first, whatever the word count', () => {
      expect(applyMask('w[-1], w[0]', 'John Smith')).toBe('Smith, John');
      expect(applyMask('w[-1], w[0]', 'Ana Maria Lopez')).toBe('Lopez, Ana');
    });

    it('moves the tail of a number to the front', () => {
      expect(applyMask('x[9]x[10] xxx-xxx-xxx', '26324315851')).toBe('51 263-243-158');
    });

    it('bare placeholders take what the indices left, in original order', () => {
      expect(applyMask('x[1]xx', 'ABC')).toBe('BAC');
    });

    it('* is the leftovers, not the tail', () => {
      expect(applyMask('x[9]x[10] *', '26324315851')).toBe('51 263243158');
    });
  });

  describe('ranges', () => {
    it('includes both ends', () => {
      expect(applyMask('x[0..3]', 'ABCDEF')).toBe('ABCD');
    });

    it('accepts negative bounds', () => {
      expect(applyMask('x[-2..-1]', 'ABCDEF')).toBe('EF');
    });

    it('runs backwards when the range does', () => {
      expect(applyMask('x[-1..0]', 'ABCDE')).toBe('EDCBA');
    });

    it('joins a word range with one space', () => {
      expect(applyMask('w[1..2]', 'a bb ccc dddd')).toBe('bb ccc');
    });
  });

  describe('duplication, which falls out of the same rules', () => {
    it('repeats the whole value — five bare x, then a sixth element', () => {
      expect(applyMask('xxxxxx[0..4]', 'ABCDE')).toBe('ABCDEABCDE');
    });

    it('repeats it without knowing the length', () => {
      expect(applyMask('*x[0..-1]', 'ABCDE')).toBe('ABCDEABCDE');
      expect(applyMask('*x[0..-1]', 'John')).toBe('JohnJohn');
    });

    it('mirrors a value of known length', () => {
      expect(applyMask('xxxx[2]x[1]x[0]', 'ABC')).toBe('ABCCBA');
    });

    it('emits the same position twice when asked', () => {
      expect(applyMask('x[1]x[1]', 'ABC')).toBe('BB');
    });

    it('echoes the head at the tail — a value a parser can self-check', () => {
      expect(applyMask('x[0..1]-*-x[0..1]', 'AB1234')).toBe('AB-1234-AB');
    });
  });

  describe('leniency', () => {
    it('an out-of-range index emits nothing, silently', () => {
      expect(applyMask('w[4]', 'John Smith')).toBe('');
      expect(applyMask('x[99]', 'AB')).toBe('');
      expect(applyMask('[w[4]]', 'John Smith')).toBe('[]');
    });

    it('clips a range to what exists', () => {
      expect(applyMask('x[3..99]', 'ABCDE')).toBe('DE');
    });

    it('leaves a word range that starts past the end empty', () => {
      expect(applyMask('w[7..9]', 'John Smith')).toBe('');
    });
  });

  describe('brackets are index syntax only right after x or w', () => {
    it('leaves a bracket elsewhere as a literal', () => {
      expect(applyMask('[tel.] xxx-xxx', '123456')).toBe('[tel.] 123-456');
    });

    it('escapes a literal bracket that does follow a placeholder', () => {
      expect(applyMask('x[1]\\[*\\]', 'ABC')).toBe('B[AC]');
    });

    it('treats an unclosed bracket as literal text', () => {
      expect(applyMask('x[abc', 'ZY')).toBe('Z[abc');
    });

    it('rejects a malformed index rather than silently printing it', () => {
      // The hyphen form is the likely habit, and it would otherwise pass through
      // as literal text and produce quietly wrong data.
      expect(() => applyMask('x[1-2]', 'ABC')).toThrow(/invalid index/);
      expect(() => applyMask('w[abc]', 'a b')).toThrow(/invalid index/);
    });
  });

  describe('code points, not UTF-16 units', () => {
    it('indexes emoji as single characters', () => {
      expect(applyMask('x[2]x[1]x[0]', '😀🎉🚀')).toBe('🚀🎉😀');
    });
  });

  describe('a mask with no index behaves exactly as before', () => {
    it('keeps the documented cases byte-for-byte', () => {
      expect(applyMask('xxx-xxx-xxx xx', '11223344595')).toBe('112-233-445 95');
      expect(applyMask('w / *', 'John of the North')).toBe('John / of the North');
      expect(applyMask('xxx-xxx', '12')).toBe('12-');
    });
  });
});
