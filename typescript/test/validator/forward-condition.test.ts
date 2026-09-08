/**
 * A condition on a `<gen>` may only read a column declared above it — TDC308.
 *
 * The rule exists because the two engines answered a forward name differently, and both
 * answers were defensible. Measured over five rows from one seed, with `A` conditional on
 * `B` declared below it:
 *
 *     mode="memory"   A is empty on every row  — B is not built yet, so the branch never fires
 *     mode="disk"     A resolves where B is p  — the lazy registry builds B on demand
 *
 * That divergence cannot be pinned as a rendering case any more, because the config is now
 * refused; what a case CAN pin is the refusal, and four of them do. What belongs here is the
 * part a fixture cannot say: which conditions the rule reaches and which it deliberately
 * leaves alone, stated as a group rather than one config at a time.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/parse.js';
import { validate } from '../../src/validator/validate.js';

function codes(config: string): string[] {
  const parsed = parse(config);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
}

const A_THEN_B = (aGen: string): string =>
  '<tdc><env count="5" seed="f1" local="en">' +
  `<sequence name="A">${aGen}</sequence>` +
  '<sequence name="B"><gen type="text" value="p,q"/></sequence>' +
  '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>';

describe('a condition answered while its column is built', () => {
  it('refuses a name declared below it, on if= and on missing_when=', () => {
    expect(codes(A_THEN_B('<gen type="text" value="x,y" if="B == p"/>'))).toEqual(['TDC308']);
    expect(
      codes(A_THEN_B('<gen type="text" value="x,y" missing="1" missing_when="B == p"/>')),
    ).toEqual(['TDC308']);
  });

  it('names the column, not the whole path, when the reference is dotted', () => {
    const parsed = parse(A_THEN_B('<gen type="text" value="x,y" if="B.p == 1"/>'));
    const [first] = validate(parsed.tree).diagnostics;
    expect(first?.code).toBe('TDC308');
    expect(first?.message).toContain('"B"');
  });

  it('says what IS available when anything is, and what to do when nothing is', () => {
    // Nothing above: there is no list to print, so the hint has to say how to fix it instead.
    const nothing = validate(parse(A_THEN_B('<gen type="text" value="x,y" if="B == p"/>')).tree)
      .diagnostics[0];
    expect(nothing?.hint).toContain('Move the <sequence>');

    // Something above: the reader gets the names they could have meant.
    const something = validate(
      parse(
        '<tdc><env count="5" seed="f1" local="en">' +
          '<sequence name="First"><gen type="text" value="1,2"/></sequence>' +
          '<sequence name="A"><gen type="text" value="x,y" if="B == p"/></sequence>' +
          '<sequence name="B"><gen type="text" value="p,q"/></sequence>' +
          '</env><block><line><data>${{A}}</data></line></block></tdc>',
      ).tree,
    ).diagnostics[0];
    expect(something?.code).toBe('TDC308');
    expect(something?.hint).toContain('First');
  });

  it('leaves the legal direction alone', () => {
    expect(
      codes(
        '<tdc><env count="5" seed="f1" local="en">' +
          '<sequence name="B"><gen type="text" value="p,q"/></sequence>' +
          '<sequence name="A"><gen type="text" value="x,y" if="B == p"/></sequence>' +
          '</env><block><line><data>${{A}}|${{B}}</data></line></block></tdc>',
      ),
    ).toEqual([]);
  });

  it('leaves `_value` alone inside missing_when, which no config declares', () => {
    expect(
      codes(
        '<tdc><env count="5" seed="f1" local="en">' +
          '<sequence name="N"><gen type="number" value="1..9" missing="1" ' +
          'missing_when="_value > 5"/></sequence>' +
          '</env><block><line><data>${{N}}</data></line></block></tdc>',
      ),
    ).toEqual([]);
  });

  it('leaves a condition read after the row is finished alone, forward name and all', () => {
    // <data if=> runs once the whole table exists — both engines agreed on this before the
    // rule and must go on agreeing. A rule applied to every condition would refuse it.
    expect(
      codes(
        '<tdc><env count="5" seed="f1" local="en">' +
          '<sequence name="A"><gen type="text" value="x,y"/></sequence>' +
          '<sequence name="B"><gen type="text" value="p,q"/></sequence>' +
          '</env><block><line if="B == p"><data if="B == q">${{A}}</data></line></block></tdc>',
      ),
    ).toEqual([]);
  });

  it('still refuses a name nothing declares, rather than calling it an order problem', () => {
    // TDC215 and TDC308 answer different questions, and the wrong one is useless: "declare it"
    // when the column exists, "move it" when it does not.
    expect(codes(A_THEN_B('<gen type="text" value="x,y" if="Nowhere == p"/>'))).toEqual(['TDC215']);
  });
});
