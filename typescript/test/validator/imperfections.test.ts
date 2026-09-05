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

describe('missing_when — the attribute that names the mechanism', () => {
  const gen = (attrs: string): string =>
    `<tdc><env count="3" seed="s"><sequence name="Age"><gen type="number" value="18..60"/></sequence>` +
    `<sequence name="V"><gen type="number" value="1..9" ${attrs}/></sequence></env>` +
    `<block><line><data>\${{V}}</data></line></block></tdc>`;

  const codes = (attrs: string): string[] =>
    validate(parse(gen(attrs)).tree).diagnostics.map((d) => d.code ?? '?');

  it('accepts a condition over another column — MAR', () => {
    expect(codes('missing="0.4" missing_when="Age < 30"')).toEqual([]);
  });

  it('accepts _value, the name that makes it MNAR', () => {
    expect(codes('missing="0.4" missing_when="_value > 5"')).toEqual([]);
  });

  it('refuses an empty condition rather than treating it as always-true', () => {
    expect(codes('missing="0.4" missing_when=""')).toContain('TDC303');
  });

  it('refuses a condition with no rate — it would decide nothing', () => {
    expect(codes('missing_when="Age < 30"')).toContain('TDC303');
  });

  /*
   * The typo case is the reason this attribute is validated at all: a misspelled
   * column is a legal bare word in this language, so the condition would simply
   * never fire and nothing would be blanked, silently. It reports as TDC215 —
   * the SAME code and wording `if=` gives — because it is routed through the
   * same deferred name pass rather than a second rule invented here.
   */
  it('reports a misspelled column exactly as if= does', () => {
    expect(codes('missing="0.4" missing_when="Agee < 30"')).toContain('TDC215');
  });

  it('reports a broken expression as a broken expression', () => {
    expect(codes('missing="0.4" missing_when="Age <"')).toContain('TDC100');
  });

  /*
   * A repeated cell holds SEVERAL values on one row and the condition asks about
   * one. Both readings are defensible — test each element, or test the row — so
   * the combination is refused rather than guessed at. It used to be accepted and
   * ignored: every element was blanked at the plain rate, from a config `check`
   * had called valid.
   */
  it('refuses a condition on a repeated cell rather than ignoring it', () => {
    expect(codes('missing="0.4" repeat="2" missing_when="_value > 5"')).toContain('TDC303');
    expect(codes('missing="0.4" repeat="2"')).toEqual([]);
  });

  it("reads _value nowhere else — it is this attribute's builtin, not the run's", () => {
    const stray =
      `<tdc><env count="3" seed="s"><sequence name="V">` +
      `<gen type="number" value="1..9" if="_value > 5"/></sequence></env>` +
      `<block><line><data>\${{V}}</data></line></block></tdc>`;
    expect(validate(parse(stray).tree).diagnostics.map((d) => d.code)).toContain('TDC215');
  });
});
