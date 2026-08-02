import { describe, expect, it } from 'vitest';

import { CharSetError, parseCharSet } from '../../src/unicode/charset.js';

describe('parseCharSet', () => {
  it('expands literal characters (any script)', () => {
    expect(parseCharSet('कखगघ')).toEqual(['क', 'ख', 'ग', 'घ']);
    expect(parseCharSet('abc')).toEqual(['a', 'b', 'c']);
  });

  it('expands a range', () => {
    expect(parseCharSet('[a-e]')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parseCharSet('[0-3]')).toEqual(['0', '1', '2', '3']);
  });

  it('mixes literals, ranges, and scripts', () => {
    expect(parseCharSet('あア[0-2]к')).toEqual(['あ', 'ア', '0', '1', '2', 'к']);
  });

  it('ignores commas and whitespace as separators between groups', () => {
    expect(parseCharSet('[a-b], [0-1]')).toEqual(['a', 'b', '0', '1']);
  });

  it('keeps a literal comma/space when placed inside a group', () => {
    expect(parseCharSet('[,]')).toEqual([',']);
    expect(parseCharSet('[ ]')).toEqual([' ']);
  });

  it('treats a hyphen at the edge of a group as a literal', () => {
    expect(parseCharSet('[a-]')).toEqual(['a', '-']);
    expect(parseCharSet('[-a]')).toEqual(['-', 'a']);
  });

  it('de-duplicates while preserving first-seen order', () => {
    expect(parseCharSet('abca[a-c]')).toEqual(['a', 'b', 'c']);
  });

  it('supports multiple ranges/literals inside one group', () => {
    expect(parseCharSet('[a-c0-1_]')).toEqual(['a', 'b', 'c', '0', '1', '_']);
  });

  it('throws on an unterminated bracket', () => {
    expect(() => parseCharSet('[a-z')).toThrow(CharSetError);
  });

  it('throws on a reversed range', () => {
    expect(() => parseCharSet('[z-a]')).toThrow(/reversed range/);
  });
});
