import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * `toColumns()` is the numeric way out of a run. The property that matters is
 * that it says the SAME thing as the text output — a second way to read one
 * run, not a second run.
 */
describe('toColumns', () => {
  const config = `<tdc><env count="50" seed="cols">
      <sequence name="N"><gen type="increment" value="1"/></sequence>
      <sequence name="MV"><gen type="formula" expr="gauss(N, 20, 6)"/></sequence>
      <sequence name="Label"><gen type="text" value="a,b" percent="50,50"/></sequence>
    </env><block><line><data>\${{N}},\${{MV}},\${{Label}}</data></line></block></tdc>`;

  it('agrees with the text output, value for value', () => {
    const tdc = new TDC({ configString: config });
    const rows = tdc
      .toString()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(','));
    const cols = tdc.toColumns();

    expect(rows).toHaveLength(50);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      expect((cols['N'] as Float64Array)[i]).toBe(Number(row[0]));
      // The numbers are the same doubles, not a rounding of them: the text is
      // what `Number()` of that double prints, so parsing it returns the double.
      expect((cols['MV'] as Float64Array)[i]).toBe(Number(row[1]));
      expect((cols['Label'] as (string | undefined)[])[i]).toBe(row[2]);
    }
  });

  it('a column of numbers is a Float64Array; anything else is not', () => {
    const cols = new TDC({ configString: config }).toColumns();
    expect(cols['N']).toBeInstanceOf(Float64Array);
    expect(cols['MV']).toBeInstanceOf(Float64Array);
    expect(cols['Label']).not.toBeInstanceOf(Float64Array);
  });

  /*
   * A typed array cannot hold "no value", so the rule is all-or-nothing: one
   * empty cell and the whole column comes back as text. Filling the gap with
   * NaN would put a number nobody generated where a `parent=` filter had
   * deliberately left nothing.
   */
  it('one empty cell makes the whole column text rather than NaN', () => {
    const cols = new TDC({
      configString: `<tdc><env count="4" seed="e">
        <sequence name="Kind"><gen type="text" value="x,y" percent="50,50"/></sequence>
        <sequence name="Only" parent="Kind.x"><gen type="number" value="7..7"/></sequence>
      </env><block><line><data>\${{Kind}}</data></line></block></tdc>`,
    }).toColumns();
    const only = cols['Only'];
    expect(only).not.toBeInstanceOf(Float64Array);
    expect((only as (string | undefined)[]).some((v) => v === undefined)).toBe(true);
  });
});
