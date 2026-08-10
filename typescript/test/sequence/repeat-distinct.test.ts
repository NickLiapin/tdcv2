/**
 * `distinct="true"` on a repeating generator.
 *
 * The case that asked for it: a double first name must not come out
 * `Jesus Jesus Gonzales`. Duplicates inside a cell are the DEFAULT and are
 * normal — these tests pin the opt-out, the refusals that keep it honest, and
 * the fact that both engines land on the same values.
 */

import { describe, expect, it } from 'vitest';

import { drawDistinct, parseRepeat, RepeatError } from '../../src/sequence/repeat.js';
import { redrawUntilFresh } from '../../src/sequence/repeat-distinct.js';
import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const TAGS = 'news,tech,sport,food,travel';

function config(sequence: string, count = 8): string {
  return (
    `<tdc><env count="${String(count)}" seed="d1" local="en">` +
    `<sequence name="T">${sequence}</sequence>` +
    '</env><block><line><data>${{T}}</data></line></block></tdc>'
  );
}

function render1(source: string, opts: RenderOptions = { now: NOW }): string {
  return render(parseStrict(source), opts);
}

function rows(sequence: string, count = 8): string[][] {
  return render1(config(sequence, count))
    .split('\n')
    .slice(0, -1)
    .map((line) => line.split(', '));
}

describe('distinct= on a repeat list', () => {
  it('is off unless asked for — a cell may hold the same value twice', () => {
    const cells = rows(`<gen type="text" value="${TAGS}" repeat="3" separator=", "/>`, 40);
    const withDuplicates = cells.filter((c) => new Set(c).size < c.length);
    // Not "may in principle" — over 40 rows of 3 from 5 values it is common.
    expect(withDuplicates.length).toBeGreaterThan(0);
  });

  it('draws a listed column without replacement', () => {
    const cells = rows(
      `<gen type="text" value="${TAGS}" repeat="3" separator=", " distinct="true"/>`,
      40,
    );
    for (const cell of cells) expect(new Set(cell).size).toBe(cell.length);
  });

  it('a full-width list comes out a permutation of the whole pool', () => {
    for (const cell of rows(
      `<gen type="text" value="${TAGS}" repeat="5" separator=", " distinct="true"/>`,
      12,
    )) {
      expect([...cell].sort()).toEqual(TAGS.split(',').sort());
    }
  });

  it('works on a DRAWN generator too, which has no pool to draw down', () => {
    for (const cell of rows(
      '<gen type="number" value="1..5" repeat="4" separator=", " distinct="true"/>',
      20,
    )) {
      expect(new Set(cell).size).toBe(4);
    }
  });

  it('gives the weighted pack Nick asked about two different first names', () => {
    for (const cell of rows(
      '<gen type="template" value="person.male.firstName" repeat="2" separator=", " distinct="true"/>',
      30,
    )) {
      expect(cell[0]).not.toBe(cell[1]);
    }
  });

  it('the streaming engine and the memory engine agree value for value', () => {
    const gen = `<gen type="text" value="${TAGS}" repeat="3" separator=", " distinct="true"/>`;
    expect(render1(config(gen, 20), { now: NOW, stream: true })).toBe(
      render1(config(gen, 20), { now: NOW, mode: 'memory' }),
    );
  });
});

describe('distinct= refusals', () => {
  const codes = (sequence: string): string[] =>
    validate(parse(config(sequence)).tree).diagnostics.map((d) => d.code ?? '');

  it('TDC289: a value that is neither true nor false', () => {
    expect(codes(`<gen type="text" value="${TAGS}" repeat="2" distinct="yes"/>`)).toContain(
      'TDC289',
    );
  });

  it('TDC290: distinct without repeat, because one value cannot repeat itself', () => {
    expect(codes(`<gen type="text" value="${TAGS}" distinct="true"/>`)).toContain('TDC290');
  });

  it('TDC291: percent and distinct cannot both hold', () => {
    expect(
      codes(`<gen type="text" value="a,b,c" repeat="2" percent="70,20,10" distinct="true"/>`),
    ).toContain('TDC291');
  });

  it('TDC291 does NOT fire without distinct — percent+repeat is a working feature', () => {
    expect(codes('<gen type="text" value="a,b,c" repeat="2" percent="70,20,10"/>')).not.toContain(
      'TDC291',
    );
  });

  it('TDC292: more values asked for than the list holds', () => {
    expect(codes(`<gen type="text" value="a,b,c" repeat="1..10" distinct="true"/>`)).toContain(
      'TDC292',
    );
    expect(codes('<gen type="number" value="1..5" repeat="9" distinct="true"/>')).toContain(
      'TDC292',
    );
  });

  it('TDC292 stays silent when the pool is big enough, and when it is unknowable', () => {
    expect(codes(`<gen type="text" value="${TAGS}" repeat="1..5" distinct="true"/>`)).not.toContain(
      'TDC292',
    );
    // A pack is read at run time, so the config alone cannot prove anything.
    expect(
      codes('<gen type="template" value="person.male.firstName" repeat="4" distinct="true"/>'),
    ).not.toContain('TDC292');
  });
});

describe('the pieces underneath', () => {
  it('parseRepeat reads distinct only when it says true', () => {
    expect(parseRepeat({ repeat: '2', distinct: 'true' })?.distinct).toBe(true);
    expect(parseRepeat({ repeat: '2', distinct: 'false' })?.distinct).toBe(false);
    expect(parseRepeat({ repeat: '2' })?.distinct).toBe(false);
  });

  it('drawDistinct refuses a list longer than the pool rather than shortening it', () => {
    expect(() =>
      drawDistinct(
        ['a', 'b'],
        [50, 50],
        3,
        () => 0.5,
        () => 'the list',
      ),
    ).toThrow(RepeatError);
  });

  it('drawDistinct honours weights: a 99% value is picked first almost always', () => {
    let hits = 0;
    for (let i = 0; i < 100; i++) {
      const u = (i + 0.5) / 100;
      hits +=
        drawDistinct(
          ['a', 'b'],
          [99, 1],
          1,
          () => u,
          () => 'the list',
        )[0] === 'a'
          ? 1
          : 0;
    }
    expect(hits).toBe(99);
  });

  it('redrawUntilFresh gives up loudly instead of returning a duplicate', () => {
    expect(() => redrawUntilFresh(['x'], 'regex', () => 'x')).toThrow(RepeatError);
    expect(redrawUntilFresh(['x'], 'regex', (s) => (s === '' ? 'x' : 'y'))).toBe('y');
  });
});
