import { describe, expect, it } from 'vitest';

import { closestMatch, formatCandidates } from '../../src/errors/suggestions.js';

describe('closestMatch', () => {
  const candidates = [
    'person.male.firstName',
    'person.female.firstName',
    'person.lastName',
    'person.gender',
    'location.country',
    'date.range',
  ];

  it('finds a case-only mismatch with distance zero priority', () => {
    expect(closestMatch('person.male.firstname', candidates)).toBe('person.male.firstName');
    expect(closestMatch('PERSON.GENDER', candidates)).toBe('person.gender');
  });

  it('finds a single-character typo', () => {
    expect(closestMatch('person.male.firstNam', candidates)).toBe('person.male.firstName');
    expect(closestMatch('person.mael.firstName', candidates)).toBeDefined();
  });

  it('returns undefined when no candidate is close', () => {
    expect(closestMatch('completely-different', candidates)).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(closestMatch('', candidates)).toBeUndefined();
    expect(closestMatch('anything', [])).toBeUndefined();
  });

  it('respects the maxDistance threshold', () => {
    // "foo" is very short; the heuristic caps allowed distance low, so
    // even "bar" shouldn't match.
    expect(closestMatch('foo', ['bar'])).toBeUndefined();
    // But close typos on longer strings succeed.
    expect(closestMatch('firstname', ['firstName'])).toBe('firstName');
  });
});

describe('formatCandidates', () => {
  it('joins short lists with commas', () => {
    expect(formatCandidates(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('truncates long lists with "(N more)"', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const out = formatCandidates(list, 3);
    expect(out).toBe('a, b, c, … (5 more)');
  });
});
