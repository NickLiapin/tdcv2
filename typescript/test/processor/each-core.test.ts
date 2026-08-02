/**
 * The `each` core: splitting a cell into elements and numbering them.
 *
 * Checked without a renderer, because two things here are easy to get subtly
 * wrong and expensive to notice later: an empty cell must mean NO rows (not one
 * blank row), and the key must never collide between cards.
 */

import { describe, expect, it } from 'vitest';

import { elementRegistry, itemKey, splitElements } from '../../src/processor/each.js';
import { sequenceValueAt, type SequenceRegistry } from '../../src/sequence/index.js';

/** Registry lookups are optional by type; every name here is known to exist. */
const at = (reg: SequenceRegistry, name: string, row: number): string | undefined =>
  sequenceValueAt(reg[name]!, row);

describe('splitElements', () => {
  it('splits on the separator the generator joined with', () => {
    expect(splitElements('a,b,c', ',')).toEqual(['a', 'b', 'c']);
    expect(splitElements('a | b', ' | ')).toEqual(['a', 'b']);
  });

  it('an empty cell is an EMPTY list, not one blank element', () => {
    // "".split(",") is [""], which would emit a row for a customer with no
    // orders — the exact bug this guards.
    expect(splitElements('', ',')).toEqual([]);
    expect(splitElements(undefined, ',')).toEqual([]);
  });

  it('keeps genuinely blank elements in the middle', () => {
    // A `missing=` element inside a list is a real slot, not an absent one.
    expect(splitElements('a,,c', ',')).toEqual(['a', '', 'c']);
  });

  it('a single element is a list of one', () => {
    expect(splitElements('only', ',')).toEqual(['only']);
  });
});

describe('itemKey', () => {
  it('numbers the first card of the first lane from 1', () => {
    expect(itemKey(1, 1, 0, 10)).toBe(1);
    expect(itemKey(1, 3, 0, 10)).toBe(3);
  });

  it('starts each card at its own block', () => {
    expect(itemKey(2, 1, 0, 10)).toBe(11);
    expect(itemKey(3, 1, 0, 10)).toBe(21);
  });

  it('gives each list its own lane inside the block', () => {
    // Two lists, maxima 3 and 2 → stride 5, lanes 0 and 3.
    expect(itemKey(1, 1, 0, 5)).toBe(1); // list A, first element
    expect(itemKey(1, 1, 3, 5)).toBe(4); // list B, first element
    expect(itemKey(2, 1, 0, 5)).toBe(6); // list A, next card
  });

  /**
   * The regression this shape exists for. With one shared counter, two lists of
   * different maxima collided: a 2000-card run produced 3501 rows carrying only
   * 3071 distinct keys. Nothing in the four-row demo revealed it.
   */
  it('never collides between two lists of different lengths', () => {
    const laneA = 0;
    const maxA = 3;
    const laneB = maxA;
    const maxB = 2;
    const stride = maxA + maxB;
    const seen = new Set<number>();
    for (let card = 1; card <= 2000; card++) {
      // Each card fills one list or the other, in varying amounts.
      const useA = card % 2 === 0;
      const lane = useA ? laneA : laneB;
      const count = useA ? (card % maxA) + 1 : (card % maxB) + 1;
      for (let position = 1; position <= count; position++) {
        const key = itemKey(card, position, lane, stride);
        expect(seen.has(key), `key ${String(key)} reused on card ${String(card)}`).toBe(false);
        seen.add(key);
      }
    }
  });

  it('never collides even when BOTH lists are full on every card', () => {
    const stride = 5;
    const seen = new Set<number>();
    for (let card = 1; card <= 500; card++) {
      for (let position = 1; position <= 3; position++)
        seen.add(itemKey(card, position, 0, stride));
      for (let position = 1; position <= 2; position++)
        seen.add(itemKey(card, position, 3, stride));
    }
    expect(seen.size).toBe(500 * 5); // every key distinct
  });

  it('increases down the file, which is the point of choosing it', () => {
    const keys: number[] = [];
    for (let card = 1; card <= 50; card++) {
      for (let position = 1; position <= 3; position++) keys.push(itemKey(card, position, 0, 5));
    }
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });
});

describe('elementRegistry', () => {
  const base = { Id: { name: 'Id', values: ['7', '8'] } };

  it('makes the list name resolve to the current element', () => {
    const reg = elementRegistry(base, 'Orders', 'abc', 2, 3, 0, 10);
    expect(at(reg, 'Orders', 0)).toBe('abc');
    expect(at(reg, 'Orders', 999)).toBe('abc'); // constant per row
  });

  it('adds the positional built-ins', () => {
    const reg = elementRegistry(base, 'Orders', 'abc', 2, 3, 0, 10);
    expect(at(reg, '_item', 0)).toBe('2');
    expect(at(reg, '_item_id', 0)).toBe('22'); // (3-1)*10 + 2
  });

  it('leaves every other sequence resolving PER CARD — the foreign key', () => {
    const reg = elementRegistry(base, 'Orders', 'abc', 1, 1, 0, 10);
    // Id must still vary by row, or every emitted child row would point at the
    // same parent.
    expect(at(reg, 'Id', 0)).toBe('7');
    expect(at(reg, 'Id', 1)).toBe('8');
  });

  it('does not mutate the registry it was given', () => {
    elementRegistry(base, 'Orders', 'abc', 1, 1, 0, 10);
    expect(Object.keys(base)).toEqual(['Id']);
  });
});
