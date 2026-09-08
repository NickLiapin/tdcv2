/**
 * `repeat="N"` beside `order="sequential"` — a row that holds several values
 * walked in order.
 *
 * The property under test is the one that decided the design: the walk CARRIES
 * ON across rows rather than restarting. That is what makes `repeat="1"` mean
 * exactly what `order="sequential"` alone has always meant, and a walk that
 * restarted per row would make the same spelling mean something new without
 * saying so.
 *
 * The refusals are here for the same reason the feature is: each names a shape
 * that has no one answer, and the alternative to refusing is data that differs
 * by engine.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

function rows(env: string, count: number, mode = 'memory'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="s" local="en" mode="${mode}">${env}</env>` +
    '<block><line><data>${{V}}</data></line></block></tdc>';
  return new TDC({ configString: config, now: NOW }).toString().trimEnd().split('\n');
}

const codes = (body: string): string[] => {
  const source =
    `<tdc><env count="10" seed="s" local="en">${body}</env>` +
    '<block><line><data>x</data></line></block></tdc>';
  const parsed = parse(source);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
};

const walked = (value: string, extra = ''): string =>
  `<sequence name="V"><gen type="text" value="${value}" order="sequential"${extra}/></sequence>`;

describe('a walked list with a fixed repeat', () => {
  it('gives every row the whole list when the repeat matches its length', () => {
    // The order lifecycle in one sequence — the config this combination was
    // invented for, and the one the relational-tables page recommends.
    expect(rows(walked('created,paid,shipped,delivered', ' repeat="4"'), 3)).toEqual([
      'created,paid,shipped,delivered',
      'created,paid,shipped,delivered',
      'created,paid,shipped,delivered',
    ]);
  });

  it('carries the walk ON across rows rather than restarting it', () => {
    // The part a single row cannot show. Restarting would print `a,b` three
    // times and pass any test that only looked at row 0.
    expect(rows(walked('a,b,c', ' repeat="2"'), 3)).toEqual(['a,b', 'c,a', 'b,c']);
  });

  it('at repeat="1" is exactly the plain walk', () => {
    // The property that makes carrying on a generalisation rather than a second
    // meaning. Both columns are built here so the claim is checked, not stated.
    const one = rows(walked('a,b,c', ' repeat="1"'), 6);
    const plain = rows(walked('a,b,c'), 6);
    expect(one).toEqual(plain);
    expect(one).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('wraps when the source runs out, as a walk always has', () => {
    expect(rows(walked('a,b', ' repeat="3"'), 2)).toEqual(['a,b,a', 'b,a,b']);
  });

  it('honours a custom separator', () => {
    expect(rows(walked('a,b,c', ' repeat="2" separator=" | "'), 2)).toEqual(['a | b', 'c | a']);
  });

  it('means the same thing on the streaming engine', () => {
    const memory = rows(walked('a,b,c', ' repeat="2"'), 8, 'memory');
    const disk = rows(walked('a,b,c', ' repeat="2"'), 8, 'disk');
    expect(disk).toEqual(memory);
  });

  it('runs out loudly under cycle="false", naming the element as well as the row', () => {
    // The message has to name a position in the WALK, not a row number that is
    // really an element index — that would send a reader to the wrong attribute.
    expect(() => rows(walked('a,b,c,d,e', ' repeat="2" cycle="false"'), 5)).toThrow(
      /row 3 runs out at element 2/,
    );
  });
});

describe('the shapes a walked repeat refuses', () => {
  it('TDC254 — a ranged repeat has no stride to walk by', () => {
    expect(codes(walked('a,b,c', ' repeat="1..3"'))).toContain('TDC254');
  });

  it('TDC254 — a walked date has one instant per row and cannot hold several', () => {
    expect(
      codes(
        '<sequence name="V"><gen type="date" from="2026-01-01" to="2026-12-31" ' +
          'repeat="3" order="sequential"/></sequence>',
      ),
    ).toContain('TDC254');
  });

  it('TDC307 — distinct= has nothing to draw without replacement', () => {
    expect(codes(walked('a,b,c', ' repeat="2" distinct="true"'))).toContain('TDC307');
  });

  it('says nothing about the fixed form it now supports', () => {
    expect(codes(walked('a,b,c', ' repeat="2"'))).toEqual([]);
  });

  it('still says nothing about a ranged repeat without a walk', () => {
    // The refusal is about the PAIR, not about either attribute alone.
    expect(
      codes('<sequence name="V"><gen type="text" value="a,b,c" repeat="1..3"/></sequence>'),
    ).toEqual([]);
  });
});
