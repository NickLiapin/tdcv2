/**
 * `type="int64|null"` / `type="decimal(18,2)"` on a named <data> — the declared
 * column type. Pure parsing; the Parquet mapping lives elsewhere.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §2.
 */

import { describe, expect, it } from 'vitest';

import {
  isListType,
  isMapType,
  isRepeatedType,
  parseColumnType,
  parseOutputColumnType,
} from '../../src/output/column-type.js';

describe('parseColumnType — plain kinds', () => {
  it('parses every v1 kind', () => {
    for (const kind of [
      'bool',
      'int32',
      'int64',
      'double',
      'string',
      'date',
      'timestamp',
      'uuid',
      'json',
    ] as const) {
      expect(parseColumnType(kind)).toEqual({ kind, nullable: false });
    }
  });

  it('is lenient about spacing and case', () => {
    expect(parseColumnType('  INT64  ')).toEqual({ kind: 'int64', nullable: false });
  });

  it('rejects an unknown kind', () => {
    expect(() => parseColumnType('nope')).toThrow(/unknown column type "nope"/);
  });

  it('rejects an empty type', () => {
    expect(() => parseColumnType('   ')).toThrow(/column type must not be empty/);
  });
});

describe('parseColumnType — nullability', () => {
  it('|null marks the column nullable', () => {
    expect(parseColumnType('double|null')).toEqual({ kind: 'double', nullable: true });
  });

  it('tolerates spaces and case around the marker', () => {
    expect(parseColumnType(' Double | NULL ')).toEqual({ kind: 'double', nullable: true });
  });

  it('rejects an unknown modifier', () => {
    expect(() => parseColumnType('int64|maybe')).toThrow(/unknown type modifier "maybe"/);
  });
});

describe('parseColumnType — decimal(p,s)', () => {
  it('parses precision and scale', () => {
    expect(parseColumnType('decimal(18,2)')).toEqual({
      kind: 'decimal',
      nullable: false,
      precision: 18,
      scale: 2,
    });
  });

  it('combines with |null', () => {
    expect(parseColumnType('decimal(9,4)|null')).toEqual({
      kind: 'decimal',
      nullable: true,
      precision: 9,
      scale: 4,
    });
  });

  it('requires parameters', () => {
    expect(() => parseColumnType('decimal')).toThrow(/decimal requires \(precision,scale\)/);
  });

  it('rejects precision beyond what int64 holds', () => {
    expect(() => parseColumnType('decimal(19,2)')).toThrow(/precision/);
  });

  it('rejects precision below 1', () => {
    expect(() => parseColumnType('decimal(0,0)')).toThrow(/precision/);
  });

  it('rejects scale greater than precision', () => {
    expect(() => parseColumnType('decimal(4,5)')).toThrow(/scale/);
  });

  it('rejects negative scale', () => {
    expect(() => parseColumnType('decimal(4,-1)')).toThrow(/scale/);
  });

  it('rejects parameters on a non-decimal kind', () => {
    expect(() => parseColumnType('int64(4,2)')).toThrow(/only decimal takes parameters/);
  });
});

/**
 * List types. `|null` deliberately binds to the ELEMENT — that is what
 * `missing=` on a repeating gen produces (blank elements), not a missing list.
 */
describe('parseOutputColumnType — lists', () => {
  it('reads a list of a scalar', () => {
    expect(parseOutputColumnType('[]int64')).toEqual({
      kind: 'list',
      element: { kind: 'int64', nullable: false },
    });
  });

  it('binds |null to the element, not the list', () => {
    const type = parseOutputColumnType('[]int64|null');
    expect(isListType(type)).toBe(true);
    expect(type).toEqual({ kind: 'list', element: { kind: 'int64', nullable: true } });
  });

  it('carries element parameters through', () => {
    expect(parseOutputColumnType('[]decimal(18,2)')).toEqual({
      kind: 'list',
      element: { kind: 'decimal', nullable: false, precision: 18, scale: 2 },
    });
  });

  it('tolerates spacing', () => {
    expect(parseOutputColumnType('  []string  ')).toEqual({
      kind: 'list',
      element: { kind: 'string', nullable: false },
    });
  });

  it('rejects a list of lists', () => {
    expect(() => parseOutputColumnType('[][]int64')).toThrow(/nested lists/);
  });

  it('rejects a list with no element type', () => {
    expect(() => parseOutputColumnType('[]')).toThrow(/element type/);
  });

  it('rejects an unknown element type', () => {
    expect(() => parseOutputColumnType('[]widget')).toThrow(/unknown column type/);
  });

  it('leaves scalars exactly as they were', () => {
    expect(parseOutputColumnType('int64|null')).toEqual({ kind: 'int64', nullable: true });
    expect(isListType(parseOutputColumnType('int64'))).toBe(false);
  });
});

/**
 * `{}T` — a map from text to T.
 *
 * The key is always text, so the type names only the value. What is refused
 * here is every shape that would need a SECOND separator to write: a map of
 * maps, a map of lists, a list of maps. None of them has a spelling, and
 * accepting one would produce a file no reader could take apart.
 */
describe('parseOutputColumnType — maps', () => {
  it('parses a map from text to a scalar', () => {
    expect(parseOutputColumnType('{}int64')).toEqual({
      kind: 'map',
      value: { kind: 'int64', nullable: false },
    });
  });

  it('binds |null to the VALUE, as it binds to a list element', () => {
    expect(parseOutputColumnType('{}int64|null')).toEqual({
      kind: 'map',
      value: { kind: 'int64', nullable: true },
    });
  });

  it('tolerates space around the value type', () => {
    expect(parseOutputColumnType('{} string ')).toEqual({
      kind: 'map',
      value: { kind: 'string', nullable: false },
    });
  });

  it('rejects a map with no value type', () => {
    expect(() => parseOutputColumnType('{}')).toThrow(/value type/);
  });

  it('rejects an unknown value type', () => {
    expect(() => parseOutputColumnType('{}widget')).toThrow(/unknown column type/);
  });

  it('rejects a map of maps — there is no second separator to write it with', () => {
    expect(() => parseOutputColumnType('{}{}int64')).toThrow(/cannot itself be a list or a map/);
  });

  it('rejects a map of lists, for the same reason', () => {
    expect(() => parseOutputColumnType('{}[]int64')).toThrow(/cannot itself be a list or a map/);
  });

  it('rejects a list of maps', () => {
    expect(() => parseOutputColumnType('[]{}int64')).toThrow(/list of maps is not supported/);
  });

  it('still rejects a list of lists', () => {
    expect(() => parseOutputColumnType('[][]int64')).toThrow(/nested lists are not supported/);
  });

  it('tells a map apart from a list, and counts both as repeated', () => {
    const map = parseOutputColumnType('{}int64');
    const list = parseOutputColumnType('[]int64');
    const scalar = parseOutputColumnType('int64');
    expect(isMapType(map)).toBe(true);
    expect(isMapType(list)).toBe(false);
    expect(isListType(map)).toBe(false);
    expect(isRepeatedType(map)).toBe(true);
    expect(isRepeatedType(list)).toBe(true);
    expect(isRepeatedType(scalar)).toBe(false);
  });
});
