/**
 * MAP columns, checked against HAND-COMPUTED levels.
 *
 * These numbers are worked out from the schema tree, not captured from our own
 * output — a snapshot of wrong levels is not a test, it is a wrong answer
 * written down twice. Levels are the one place that must not be verified
 * circularly: get them wrong and every reader accepts the file and then
 * re-assembles it into the wrong shape.
 *
 *     required group <name> (MAP)      +0 def, +0 rep
 *         repeated group key_value     +1 def, +1 rep
 *             required key             +0 def   → max def 1
 *             optional value           +1 def   → max def 2
 */

import { describe, expect, it } from 'vitest';

import {
  buildMapLevels,
  MAP_KEY_MAX_DEF,
  mapValueMaxDef,
  parseMapCell,
} from '../../src/output/parquet/map.js';

describe('the levels a map schema allows', () => {
  it('gives the key one level and the value one or two', () => {
    expect(MAP_KEY_MAX_DEF).toBe(1);
    expect(mapValueMaxDef(false)).toBe(1);
    expect(mapValueMaxDef(true)).toBe(2);
  });
});

describe('parseMapCell', () => {
  it('reads key:value pairs in the order written', () => {
    expect(parseMapCell('a:1,b:2', ',', false)).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
    ]);
  });

  it('splits on the FIRST colon, so a value may hold more', () => {
    // A timestamp is the case this exists for.
    expect(parseMapCell('start:12:30:00', ',', false)).toEqual([
      { key: 'start', value: '12:30:00' },
    ]);
  });

  it('reads an empty cell as an empty map, not a map holding one blank', () => {
    expect(parseMapCell('', ',', false)).toEqual([]);
  });

  it('makes an empty value NULL only when the value is nullable', () => {
    expect(parseMapCell('a:', ',', true)).toEqual([{ key: 'a', value: undefined }]);
    expect(parseMapCell('a:', ',', false)).toEqual([{ key: 'a', value: '' }]);
  });

  /*
   * Each of these would otherwise produce a map quietly missing an entry — the
   * failure this whole column type exists to avoid, since a map that loses a
   * key still reads as a perfectly good file.
   */
  it('refuses a piece with no colon', () => {
    expect(() => parseMapCell('oops', ',', false)).toThrow(/has no ":"/);
  });

  it('refuses an empty key, which Parquet cannot store', () => {
    expect(() => parseMapCell(':5', ',', false)).toThrow(/empty key/);
  });

  it('refuses a key that repeats in one cell', () => {
    // Readers disagree about which of the two wins; some drop the row's map.
    expect(() => parseMapCell('a:1,a:2', ',', false)).toThrow(/appears twice/);
  });
});

describe('buildMapLevels', () => {
  it('numbers the pairs of a row 0 then 1, and holds the key at def 1', () => {
    const levels = buildMapLevels(
      [
        [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
        ],
      ],
      false,
    );
    expect(levels.repLevels).toEqual([0, 1]);
    expect(levels.keyDefLevels).toEqual([1, 1]);
    expect(levels.valueDefLevels).toEqual([1, 1]);
    expect(levels.keys).toEqual(['a', 'b']);
    expect(levels.present).toEqual(['1', '2']);
  });

  it('spends one slot on an empty map, at def 0 in BOTH leaves', () => {
    // Without the slot the row would vanish from the column and every row after
    // it would shift up by one — a file that reads, with the wrong data in it.
    const levels = buildMapLevels([[], [{ key: 'a', value: '1' }]], false);
    expect(levels.repLevels).toEqual([0, 0]);
    expect(levels.keyDefLevels).toEqual([0, 1]);
    expect(levels.valueDefLevels).toEqual([0, 1]);
    expect(levels.keys).toEqual(['a']);
  });

  it('marks a NULL value one below its maximum, and keeps the key', () => {
    const levels = buildMapLevels([[{ key: 'a', value: undefined }]], true);
    expect(levels.keyDefLevels).toEqual([1]); // the pair exists
    expect(levels.valueDefLevels).toEqual([1]); // maxDef 2, so 1 is "no value"
    expect(levels.keys).toEqual(['a']);
    expect(levels.present).toEqual([]); // nothing to encode
  });

  it('starts each row at rep 0 however long the row before it was', () => {
    const levels = buildMapLevels(
      [
        [
          { key: 'a', value: '1' },
          { key: 'b', value: '2' },
          { key: 'c', value: '3' },
        ],
        [{ key: 'd', value: '4' }],
      ],
      false,
    );
    expect(levels.repLevels).toEqual([0, 1, 1, 0]);
  });
});
