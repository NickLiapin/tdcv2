/**
 * A `<switch>` written inside a `<case>`.
 *
 * Nick's case is a national id whose SHAPE depends on the gender and, for one
 * gender only, on the region. Before this, the only way to write that was a
 * separate sequence per combination plus an expression to pick between them —
 * three declarations to say one thing, and nothing tying them together.
 *
 * `<case>` is shared by `<mix>` and `<switch>`, so allowing a nested `<switch>`
 * allows it under both parents at once. That was asked for explicitly: "почему
 * switch в свече не работает и switch в Mix не работает?"
 *
 * ── What these tests are for ─────────────────────────────────────────────────
 * A nested switch partitions ONLY the rows of the branch it sits in. Whether it
 * does that correctly cannot be seen from counts — the counts come out right
 * either way — so every test here compares the two engines ROW FOR ROW, which
 * is how the ordering fault in the enclosing feature was found.
 */
import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

/** The rendered rows for each of `seeds` seeds, on the given engine. */
function rows(config: (seed: string) => string, engine?: string, seeds = 20): string[][] {
  const runs: string[][] = [];
  for (let s = 0; s < seeds; s++) {
    const source = config(`s${String(s)}`).replace(
      '<env ',
      engine === undefined ? '<env ' : `<env engine="${engine}" `,
    );
    runs.push(new TDC({ configString: source }).toString().split('\n').filter(Boolean));
  }
  return runs;
}

const BY_REGION = (seed: string): string => `<tdc version="0.1">
  <env count="12" seed="${seed}" local="en">
    <sequence name="Sex"><gen type="text" value="male,female" percent="50,50"/></sequence>
    <sequence name="Region"><gen type="text" value="north,south" percent="50,50"/></sequence>
    <switch name="Id" on="Sex">
      <case is="male"><data>M</data></case>
      <case is="female">
        <switch on="Region">
          <case is="north"><data>FN</data></case>
          <case is="south"><data>FS</data></case>
        </switch>
      </case>
    </switch>
  </env>
  <block><line><data>\${{Sex}}/\${{Region}}=\${{Id}}</data></line></block>
</tdc>`;

describe('a <switch> inside a <case>', () => {
  it('answers for the rows of the branch it sits in, and only those', () => {
    // Both engines named explicitly. Left to choose, this config resolves to the
    // streaming engine, and a version of this test that said nothing passed
    // while the in-memory path was reading the subject at the wrong row.
    for (const run of [...rows(BY_REGION, '1'), ...rows(BY_REGION, '2')]) {
      for (const row of run) {
        // The claim in full: the value is decided by BOTH subjects, and a male
        // row never reaches the inner switch at all.
        const [key, value] = row.split('=');
        const expected = { 'male/north': 'M', 'male/south': 'M', 'female/north': 'FN' }[key ?? ''];
        expect(value).toBe(expected ?? 'FS');
      }
    }
  });

  it('gives the same rows on the in-memory and the streaming engine', () => {
    expect(rows(BY_REGION, '1')).toEqual(rows(BY_REGION, '2'));
  });

  it('works inside a <mix> case too, on both engines', () => {
    const config = (seed: string): string => `<tdc version="0.1">
  <env count="12" seed="${seed}" local="en">
    <sequence name="Region"><gen type="text" value="EU,US" percent="50,50"/></sequence>
    <mix name="Doc" percent="50,50">
      <case><data>invoice-</data>
        <switch on="Region">
          <case is="EU"><data>VAT</data></case>
          <case is="US"><data>SalesTax</data></case>
        </switch>
      </case>
      <case><data>receipt</data></case>
    </mix>
  </env>
  <block><line><data>\${{Region}}|\${{Doc}}</data></line></block>
</tdc>`;
    const memory = rows(config, '1');
    expect(memory).toEqual(rows(config, '2'));
    for (const run of memory) {
      // An invoice always names the tax its own region uses; a receipt names none.
      expect(run.filter((r) => r.startsWith('EU') && r.includes('SalesTax'))).toEqual([]);
      expect(run.filter((r) => r.startsWith('US') && r.includes('VAT'))).toEqual([]);
    }
  });

  it('takes a share inside a nested branch over that branch alone', () => {
    // 8 rows split 4/4 by Sex, and the female rows split 2/2 by Region. The
    // inner 50/50 therefore divides TWO rows — one each, on every seed. Built
    // over anything wider it could give both to one value.
    const config = (seed: string): string => `<tdc version="0.1">
  <env count="8" seed="${seed}" local="en">
    <sequence name="Sex"><gen type="text" value="male,female" percent="50,50"/></sequence>
    <sequence name="Region"><gen type="text" value="north,south" percent="50,50"/></sequence>
    <switch name="Id" on="Sex">
      <case is="male"><data>M</data></case>
      <case is="female">
        <switch on="Region">
          <case is="north">
            <mix percent="50,50">
              <case><data>FN-a</data></case>
              <case><data>FN-b</data></case>
            </mix>
          </case>
          <case is="south"><data>FS</data></case>
        </switch>
      </case>
    </switch>
  </env>
  <block><line><data>\${{Sex}}/\${{Region}}=\${{Id}}</data></line></block>
</tdc>`;
    // Engine 1 only, and that is the point of the second half of this test: a
    // share inside a nested branch covers an intersection of two partitions,
    // which the streaming engines cannot number a row at a time. They refuse it
    // rather than spread the quota over the wrong rows.
    for (const run of rows(config, '1')) {
      const northFemale = run.filter((r) => r.startsWith('female/north'));
      if (northFemale.length !== 2) continue; // this seed split the rows differently
      expect(northFemale.filter((r) => r.endsWith('FN-a'))).toHaveLength(1);
      expect(northFemale.filter((r) => r.endsWith('FN-b'))).toHaveLength(1);
    }
    expect(() => rows(config, '2', 1)).toThrow(/percentage inside <case is="north">/);
    // Left to itself the router picks the engine that can, so the config runs.
    expect(rows(config, undefined, 1)).toEqual(rows(config, '1', 1));
  });

  it('sends <default> the rows of the branch that matched no inner key', () => {
    const config = (seed: string): string => `<tdc version="0.1">
  <env count="12" seed="${seed}" local="en">
    <sequence name="Sex"><gen type="text" value="male,female" percent="50,50"/></sequence>
    <sequence name="Region"><gen type="text" value="north,south,east" percent="34,33,33"/></sequence>
    <switch name="Id" on="Sex">
      <case is="male"><data>M</data></case>
      <case is="female">
        <switch on="Region">
          <case is="north"><data>FN</data></case>
          <default><data>F?</data></default>
        </switch>
      </case>
    </switch>
  </env>
  <block><line><data>\${{Sex}}/\${{Region}}=\${{Id}}</data></line></block>
</tdc>`;
    for (const run of [...rows(config, '1'), ...rows(config, '2')]) {
      for (const row of run) {
        const [key, value] = row.split('=');
        if (key?.startsWith('male')) expect(value).toBe('M');
        else if (key === 'female/north') expect(value).toBe('FN');
        else expect(value).toBe('F?'); // south and east both fall through
      }
    }
  });

  it('refuses a name on the nested form — it names nothing', () => {
    const source = `<tdc><env count="4" seed="n" local="en">
      <sequence name="R"><gen type="text" value="a,b"/></sequence>
      <switch name="Outer" on="R">
        <case is="a"><switch name="Inner" on="R"><case is="a"><data>x</data></case></switch></case>
        <default><data>y</data></default>
      </switch>
    </env><block><line><data>\${{Outer}}</data></line></block></tdc>`;
    const parsed = parse(source);
    expect(parsed.diagnostics).toEqual([]);
    const codes = validate(parsed.tree).diagnostics.map((d) => d.code);
    expect(codes).toContain('TDC245');
  });

  it('holds the nested form to the same unknown-subject rule as the outer one', () => {
    const source = `<tdc><env count="4" seed="n" local="en">
      <sequence name="R"><gen type="text" value="a,b"/></sequence>
      <switch name="Outer" on="R">
        <case is="a"><switch on="Nowhere"><case is="a"><data>x</data></case></switch></case>
        <default><data>y</data></default>
      </switch>
    </env><block><line><data>\${{Outer}}</data></line></block></tdc>`;
    const parsed = parse(source);
    expect(parsed.diagnostics).toEqual([]);
    expect(validate(parsed.tree).diagnostics.map((d) => d.code)).toContain('TDC134');
  });
});
