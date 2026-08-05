/**
 * TDC251 — a `percent` share that asks for less than one whole row.
 *
 * The report that produced this: ten records, sex 50/50, a `<switch on>` per sex,
 * and a `<mix percent="10,90">` inside each branch picking a sex-specific
 * diagnosis. The women got one, the men got none, and the data, the config and
 * the split were all correct — five male rows, ten percent of five is half a
 * record, and half a record cannot be emitted. The engine rounded and said
 * nothing, so an afternoon went into proving that nothing was broken.
 *
 * ── What makes this hard to spot without a diagnostic ────────────────────────
 * The output is STABLE. Same seed, same rows, forever. Re-running proves
 * nothing and the column reads like a config that was never written rather than
 * one that rounded away. That is determinism working exactly as promised.
 *
 * ── Why these tests are mostly about SILENCE ─────────────────────────────────
 * A check that guesses the denominator fires on working configs and gets turned
 * off, which is worse than the silence it replaces. Most of what follows pins
 * the cases where this must say nothing.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const codes = (source: string): string[] => {
  const parsed = parse(source);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
};

const first = (source: string): string => {
  const found = validate(parse(source).tree).diagnostics.find((d) => d.code === 'TDC251');
  return `${found?.message ?? ''} :: ${found?.hint ?? ''}`;
};

const doc = (count: number, body: string): string =>
  `<tdc><env count="${String(count)}" seed="s" local="en">${body}</env>` +
  '<block><line><data>x</data></line></block></tdc>';

const TWO = '<case><data>a</data></case><case><data>b</data></case>';

/** The reported shape: a mix inside a switch branch, the branch being half the run. */
const inBranch = (count: number, percent: string): string =>
  doc(
    count,
    '<sequence name="G"><gen type="text" value="M,F" percent="50,50"/></sequence>' +
      `<switch name="D" on="G"><case is="M"><mix percent="${percent}">${TWO}</mix></case>` +
      '<case is="F"><data>x</data></case></switch>',
  );

describe('a share that rounds away', () => {
  it('warns on the config that was reported', () => {
    expect(codes(inBranch(10, '10,90'))).toContain('TDC251');
  });

  it('carries the arithmetic, because the number in the config is not the wrong one', () => {
    // "percent=10 is too small" would be false — it is right for 20 rows. What
    // is wrong is 10% OF FIVE, and the message has to hold both halves.
    expect(first(inBranch(10, '10,90'))).toContain('percent="10" over 5 rows asks for 0.5 records');
  });

  it('says nothing once the share covers a whole row', () => {
    expect(codes(inBranch(10, '20,80'))).not.toContain('TDC251');
  });

  it('says nothing once the count covers it instead', () => {
    // The same 10%, and the same branch, over twice the rows.
    expect(codes(inBranch(20, '10,90'))).not.toContain('TDC251');
  });

  it('warns once per element, not once per thin share', () => {
    // Three branches of 1% over 10 rows are three faults of one kind. Saying it
    // three times about one <mix> teaches nothing the first line did not.
    const thin = doc(
      10,
      '<mix name="M" percent="1,1,1,97"><case><data>a</data></case><case><data>b</data></case>' +
        '<case><data>c</data></case><case><data>d</data></case></mix>',
    );
    expect(codes(thin).filter((c) => c === 'TDC251')).toHaveLength(1);
  });
});

describe('the denominator, where the config states it', () => {
  it('is count for a mix at the top of env', () => {
    expect(codes(doc(50, `<mix name="M" percent="1,99">${TWO}</mix>`))).toContain('TDC251');
    expect(codes(doc(1000, `<mix name="M" percent="1,99">${TWO}</mix>`))).not.toContain('TDC251');
  });

  it('is count for a text generator writing its own shares', () => {
    const thin = '<sequence name="T"><gen type="text" value="a,b" percent="2,98"/></sequence>';
    expect(codes(doc(10, thin))).toContain('TDC251');
    expect(codes(doc(100, thin))).not.toContain('TDC251');
  });

  it('follows a parent= down to its subset', () => {
    // 30 of 100 rows are Paid; 2% of those 30 is 0.6 of a record.
    const body =
      '<sequence name="S"><gen type="text" value="Free,Paid" percent="70,30"/></sequence>' +
      `<mix name="T" parent="S.Paid" percent="2,98">${TWO}</mix>`;
    expect(codes(doc(100, body))).toContain('TDC251');
    expect(codes(doc(1000, body))).not.toContain('TDC251');
  });

  it('adds the shares a multi-key branch matches', () => {
    // `is="A|B"` reaches 20% of the rows, not 10%, so 5% of it is a whole record
    // at 100 rows. Counting one key only would have called this thin.
    const body =
      '<sequence name="K"><gen type="text" value="A,B,C" percent="10,10,80"/></sequence>' +
      `<switch name="D" on="K"><case is="A|B"><mix percent="5,95">${TWO}</mix></case>` +
      '<default><data>x</data></default></switch>';
    expect(codes(doc(100, body))).not.toContain('TDC251');
  });
});

describe('where it must stay silent', () => {
  it('says nothing when the subject declares no shares', () => {
    // An even split is the DEFAULT, not a statement; reading it as one would put
    // a number in the message that the config never wrote.
    const body =
      '<sequence name="G"><gen type="text" value="M,F"/></sequence>' +
      `<switch name="D" on="G"><case is="M"><mix percent="10,90">${TWO}</mix></case>` +
      '<case is="F"><data>x</data></case></switch>';
    expect(codes(doc(10, body))).not.toContain('TDC251');
  });

  it('says nothing when the parent is not a name it can resolve', () => {
    const body = `<mix name="T" parent="Nope.Value" percent="1,99">${TWO}</mix>`;
    expect(codes(doc(10, body))).not.toContain('TDC251');
  });

  it('says nothing about a repeat=, whose quota is over ELEMENTS', () => {
    // Three per row over four rows is twelve draws, and `repeat="1..3"` does not
    // even fix how many. Rows is the wrong denominator, so this holds its tongue
    // rather than guess — found by an existing test that asserted no complaint.
    const thin =
      '<sequence name="T"><gen type="text" value="a,b" percent="70,30" repeat="3"/></sequence>';
    expect(codes(doc(2, thin))).not.toContain('TDC251');
  });

  it('says nothing about a zero share, which asks for nothing on purpose', () => {
    expect(codes(doc(10, `<mix name="M" percent="0,100">${TWO}</mix>`))).not.toContain('TDC251');
  });

  it("says nothing when the mask does not parse — that is another code's job", () => {
    const broken = doc(10, `<mix name="M" percent="1,2,3">${TWO}</mix>`);
    expect(codes(broken)).not.toContain('TDC251');
  });
});
