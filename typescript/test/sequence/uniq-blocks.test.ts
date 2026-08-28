/**
 * A `<uniq>` group with a `<switch>` in it: the deal ACROSS the blocks.
 *
 * A switch cuts the group's rows into blocks — male rows here, female rows
 * there — because a switched value answers the subject of its own row and
 * cannot move to a row with a different one. Everything else in the group is
 * free to move anywhere, and until the deal existed it did not: each block
 * arranged whatever values happened to fall into it.
 *
 * That was expensive. A `text` list is laid out in exact shares over the WHOLE
 * column; the cut then hands one block `[7,3,4]` where an even share is
 * `[5,5,4]`, and the difference is real — 13 achievable tuples against 14, on
 * data holding 18 combinations. The run was refused for want of data it had.
 *
 * Two things have to hold at once here, and the second is the one that bites:
 * the group must reach further than it did, AND no value may cross a block. A
 * deal that moves the switched column, or the SUBJECT the blocks were cut by,
 * buys distinct rows by putting a male name on a female row — which is the
 * failure this whole area exists to prevent, and it is not a trade worth making.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

/** Male and female draw from disjoint name and diagnosis lists on purpose. */
const config = (count: number): string =>
  `<tdc><env count="${String(count)}" seed="s" local="en">
    <uniq>
      <sequence name="G"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
      <switch name="F" on="G">
        <case is="Male"><gen type="text" value="m1,m2"/></case>
        <case is="Female"><gen type="text" value="f1,f2"/></case>
      </switch>
      <sequence name="L"><gen type="text" value="a,b,c"/></sequence>
      <switch name="D" on="G">
        <case is="Male"><mix percent="20,80"><case><gen type="text" value="dm"/></case><case><gen type="text" value="g1,g2"/></case></mix></case>
        <case is="Female"><mix percent="20,80"><case><gen type="text" value="df"/></case><case><gen type="text" value="g1,g2"/></case></mix></case>
      </switch>
    </uniq>
  </env><block><line><data>\${{G}}|\${{F}}|\${{L}}|\${{D}}</data></line></block></tdc>`;

const rowsOf = (count: number): string[][] =>
  new TDC({ configString: config(count) })
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));

describe('a uniq group split into blocks by a switch', () => {
  it('never puts a value on a row whose subject it does not answer', () => {
    // The invariant, checked before anything about counts. A deal that moved
    // the switched column — or the subject itself — produced eighteen rows of
    // thirty-six carrying the other gender's name, and every one of them was a
    // "distinct" row. Coherence is not something to trade for reach.
    for (const count of [8, 20, 29, 30]) {
      for (const [gender, first, , diagnosis] of rowsOf(count)) {
        const own = gender === 'Male' ? /^m/ : /^f/;
        expect(first, `${String(gender)} row carried ${String(first)}`).toMatch(own);
        expect(
          diagnosis === (gender === 'Male' ? 'df' : 'dm'),
          `${String(gender)} row carried ${String(diagnosis)}`,
        ).toBe(false);
      }
    }
  });

  it('makes every row distinct, up to what the data really allows', () => {
    for (const count of [8, 20, 28, 29, 30]) {
      const rows = rowsOf(count).map((cells) => cells.join('|'));
      expect(rows).toHaveLength(count);
      expect(new Set(rows).size, `count=${String(count)}`).toBe(count);
    }
  });

  it('reaches counts it used to refuse', () => {
    // 29 and 30 were refused before the deal, on data that held them. The
    // numbers are the point of this test: if the deal stops working, these are
    // what go back to being an error.
    expect(rowsOf(29)).toHaveLength(29);
    expect(rowsOf(30)).toHaveLength(30);
  });

  it('still refuses what the data cannot hold, rather than repeating a row', () => {
    // 31 is past the ceiling: the mix's 20/80 forces the diagnosis column into
    // shares that cap a block at 15, so two blocks hold 30. Refusing is the
    // right answer and a duplicate row would be the wrong one.
    expect(() => rowsOf(31)).toThrow(/cannot produce 31 unique combinations/);
  });

  it('keeps every declared share exactly, which is why it deals and never redraws', () => {
    const rows = rowsOf(30);
    const genders = rows.filter(([g]) => g === 'Male').length;
    expect(genders).toBe(15); // percent="50,50" over 30

    // 20/80 within the male block: 3 gendered diagnoses, 12 general.
    const male = rows.filter(([g]) => g === 'Male');
    expect(male.filter(([, , , d]) => d === 'dm')).toHaveLength(3);
    expect(male.filter(([, , , d]) => d !== 'dm')).toHaveLength(12);
  });

  it('leaves a group with no switch exactly as it was', () => {
    // With nothing to cut the rows by there is one block, and the deal over one
    // block is the identity. This is the shape most configs have, and it must
    // not move a byte.
    const plain =
      '<tdc><env count="12" seed="s" local="en"><uniq>' +
      '<sequence name="A"><gen type="text" value="a,b,c"/></sequence>' +
      '<sequence name="B"><gen type="text" value="1,2,3,4"/></sequence>' +
      '</uniq></env><block><line><data>${{A}}${{B}}</data></line></block></tdc>';
    const out = new TDC({ configString: plain }).toString().split('\n').filter(Boolean);
    expect(out).toHaveLength(12);
    expect(new Set(out).size).toBe(12);
  });
});
