/**
 * The checks that moved out of the run and into `check`.
 *
 * Three of them were the same defect wearing different clothes: a config that
 * `tdcv2 check` called valid and the very next command refused. `anomaly="10x"`
 * and `missing="2"` died in the sequence builder; `<gen type="pattern"/>` died
 * on row one. The fourth is the quieter kind — an `anomaly=` on a list of words
 * is honoured, changes nothing, and says nothing about it.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function codes(source: string): string[] {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  return validate(result.tree).diagnostics.map((d) => d.code ?? '?');
}

const wrap = (gen: string) =>
  `<tdc><env count="4" seed="imp" local="en"><sequence name="X">${gen}</sequence></env>` +
  `<block><line><data>\${{X}}</data></line></block></tdc>`;

describe('validator — anomaly= and missing= (TDC242, TDC243)', () => {
  it('refuses a probability that is not a number', () => {
    expect(codes(wrap('<gen type="text" value="a,b,c" anomaly="10x"/>'))).toEqual(['TDC242']);
  });

  it('refuses a probability above one, on either wrapper', () => {
    expect(codes(wrap('<gen type="number" value="1..9" anomaly="2"/>'))).toEqual(['TDC242']);
    expect(codes(wrap('<gen type="number" value="1..9" missing="2"/>'))).toEqual(['TDC242']);
  });

  it('accepts the two ends of the range and an empty attribute', () => {
    expect(codes(wrap('<gen type="number" value="1..9" anomaly="0" missing="1"/>'))).toEqual([]);
    expect(codes(wrap('<gen type="number" value="1..9" anomaly=""/>'))).toEqual([]);
  });

  it('refuses an anomaly on a list with nothing numeric in it', () => {
    expect(codes(wrap('<gen type="text" value="alpha,beta,gamma" anomaly="0.3"/>'))).toEqual([
      'TDC243',
    ]);
  });

  it('leaves an anomaly alone when one value in the list is a number', () => {
    expect(codes(wrap('<gen type="text" value="alpha,42,gamma" anomaly="0.3"/>'))).toEqual([]);
  });

  it('says nothing about a list of words when the anomaly is switched off', () => {
    expect(codes(wrap('<gen type="text" value="alpha,beta" anomaly="0"/>'))).toEqual([]);
  });

  it('does not guess at a source whose values are not in the config', () => {
    expect(codes(wrap('<gen type="regex" value="[a-z]{3}" anomaly="0.3"/>'))).toEqual([]);
  });
});

describe('validator — a drawing with nothing to draw (TDC244)', () => {
  it('refuses a pattern given no shape at all', () => {
    // Two independent things are missing, and both are said: there is nothing to
    // draw, and no axis to draw it into.
    expect(codes(wrap('<gen type="pattern"/>'))).toEqual(['TDC293', 'TDC244']);
  });

  it('accepts each of the three ways to give it one', () => {
    expect(codes(wrap('<gen type="pattern" points="0,0 1,5 2,3" y_range="0..10"/>'))).toEqual([]);
    expect(codes(wrap('<gen type="pattern" upper="0,9 1,9" y_range="0..10"/>'))).toEqual([]);
    // A src= that does not resolve is TDC061, which is a different complaint —
    // what matters here is that TDC244 stands down once a shape is named.
    expect(codes(wrap('<gen type="pattern" src="nowhere.svg" y_range="0..10"/>'))).toEqual([
      'TDC061',
    ]);
  });
});
