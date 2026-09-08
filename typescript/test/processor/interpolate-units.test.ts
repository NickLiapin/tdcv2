/**
 * The interpolation module, tested as units rather than through a render.
 *
 * Three callers share it and each asks a slightly different question: the
 * output line resolves against a finished registry, a pack body against its own
 * inner one, and a `<data>` inside a `<case>` against one row read through a
 * function. What has to be identical between them is the SPELLING — which
 * markers count, how a filter chain is split, and what happens to a name that
 * resolves to nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INJECT,
  caseDataReader,
  hasInterpolation,
  interpolateWith,
} from '../../src/processor/interpolate.js';

const read =
  (values: Record<string, string>) =>
  (name: string): string | undefined =>
    Object.hasOwn(values, name) ? values[name] : undefined;

describe('interpolateWith — resolution by reader', () => {
  it('substitutes a name the reader knows', () => {
    expect(interpolateWith('${{A}}/${{B}}', DEFAULT_INJECT, read({ A: 'x', B: 'y' }))).toBe('x/y');
  });

  it('leaves a name the reader does not know exactly as written', () => {
    // The marker surviving is the whole point: a typo is visible in the first
    // row rather than silently becoming an empty column.
    expect(interpolateWith('a ${{Nope}} b', DEFAULT_INJECT, read({}))).toBe('a ${{Nope}} b');
  });

  it('substitutes an empty value as empty text, not as the marker', () => {
    // A declared column with nothing in it on this row is not the same thing as
    // a name nobody declared.
    expect(interpolateWith('[${{A}}]', DEFAULT_INJECT, read({ A: '' }))).toBe('[]');
  });

  it('returns literal text untouched, with no reference in it', () => {
    expect(interpolateWith('plain text', DEFAULT_INJECT, read({}))).toBe('plain text');
  });

  it('applies a filter chain left to right', () => {
    expect(interpolateWith('${{A|upper}}', DEFAULT_INJECT, read({ A: 'ab' }))).toBe('AB');
    expect(interpolateWith('${{A | trim | upper}}', DEFAULT_INJECT, read({ A: ' ab ' }))).toBe(
      'AB',
    );
  });

  it('reads a filter argument after the colon', () => {
    expect(interpolateWith('${{A|slice:0,3}}', DEFAULT_INJECT, read({ A: 'abcdef' }))).toBe('abc');
  });

  it('ignores a filter nobody implements rather than dropping the value', () => {
    // An unknown filter is the validator's business; the value still has to
    // come through, correct and unformatted, rather than vanish.
    expect(interpolateWith('${{A|nosuch}}', DEFAULT_INJECT, read({ A: 'x' }))).toBe('x');
  });

  it('honours a custom marker, and then ignores the default one', () => {
    expect(interpolateWith('[A] ${{A}}', '[%]', read({ A: 'x' }))).toBe('x ${{A}}');
  });

  it('is a no-op when the marker has no % slot to fill', () => {
    expect(interpolateWith('${{A}}', 'no-slot', read({ A: 'x' }))).toBe('${{A}}');
  });

  it('substitutes every occurrence, not only the first', () => {
    expect(interpolateWith('${{A}}${{A}}${{A}}', DEFAULT_INJECT, read({ A: 'z' }))).toBe('zzz');
  });
});

describe('hasInterpolation — the cheap way out', () => {
  it('is false for text with no reference', () => {
    expect(hasInterpolation('plain', DEFAULT_INJECT)).toBe(false);
  });

  it('is true for text with one', () => {
    expect(hasInterpolation('a ${{X}} b', DEFAULT_INJECT)).toBe(true);
  });

  it("is false when the marker is not the document's", () => {
    expect(hasInterpolation('${{X}}', '[%]')).toBe(false);
  });

  it('is false when the marker names no slot', () => {
    expect(hasInterpolation('${{X}}', 'nothing')).toBe(false);
  });
});

describe('caseDataReader — one row of a case body', () => {
  const has = (name: string): boolean => name === 'City';
  const at = (name: string, row: number): string | undefined =>
    name === 'City' ? ['Alpha', 'Beta'][row] : undefined;

  it('returns undefined for text that holds no reference', () => {
    // The caller keeps its cheaper path, so a literal case body costs nothing.
    expect(caseDataReader('plain', undefined, has, at)).toBeUndefined();
  });

  it('reads the row it is given, not the first one', () => {
    const reader = caseDataReader('${{City}}!', undefined, has, at);
    expect(reader?.(0)).toBe('Alpha!');
    expect(reader?.(1)).toBe('Beta!');
  });

  it('falls back to the default marker when the document names none', () => {
    expect(caseDataReader('${{City}}', undefined, has, at)?.(0)).toBe('Alpha');
  });

  it("uses the document's own marker when it has one", () => {
    expect(caseDataReader('[City]', '[%]', has, at)?.(0)).toBe('Alpha');
    expect(caseDataReader('${{City}}', '[%]', has, at)).toBeUndefined();
  });

  it('leaves a name no column answers to as written', () => {
    expect(caseDataReader('${{Nope}}', undefined, has, at)?.(0)).toBe('${{Nope}}');
  });

  it('renders a known column with no value on this row as empty', () => {
    expect(caseDataReader('[${{City}}]', undefined, has, at)?.(9)).toBe('[]');
  });

  it('works with no reader at all — every name is then unknown', () => {
    expect(caseDataReader('${{City}}', undefined, undefined, undefined)?.(0)).toBe('${{City}}');
  });
});
