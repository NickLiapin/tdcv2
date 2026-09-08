/**
 * `${{Name}}` inside a `<case>` — a case body that reads the row it is on.
 *
 * What this pins is not only that it works, but WHICH row it reads. A case is
 * built for the subset of rows that chose it, so an implementation that read a
 * position rather than an absolute row would pair the wrong values together and
 * still produce a plausible-looking file.
 *
 * Before this existed the seven characters `${{City}}` reached the output
 * verbatim, on every engine, with `check` calling the config valid. The last
 * group here is what stops that from coming back.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

function rows(env: string, count: number, mode = 'memory'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="s" local="en" mode="${mode}">${env}</env>` +
    '<block><line><data>${{S}}</data></line></block></tdc>';
  return new TDC({ configString: config, now: NOW }).toString().trimEnd().split('\n');
}

const codes = (body: string, inject = ''): string[] => {
  const source =
    `<tdc><env count="10" seed="s" local="en"${inject}>${body}</env>` +
    '<block><line><data>x</data></line></block></tdc>';
  const parsed = parse(source);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
};

const CITY = '<sequence name="City"><gen type="text" value="Alpha,Beta,Gamma"/></sequence>';

describe('a <data> inside a <case> reads its row', () => {
  it("substitutes the row's own value, not a fresh draw", () => {
    const out = rows(
      `${CITY}<mix name="S" percent="60">` +
        '<case><data>${{City}} North</data></case>' +
        '<case><data>${{City}} South</data></case></mix>',
      6,
    );
    // Whichever branch a row took, what stands where the marker was is a real
    // city rather than the marker itself.
    expect(out).toHaveLength(6);
    for (const line of out) {
      expect(line).toMatch(/^(Alpha|Beta|Gamma) (North|South)$/);
    }
  });

  it('pairs each row with ITS city, across both branches', () => {
    // The strongest form of the claim: print the column beside the case and the
    // two must agree on every row.
    const config =
      '<tdc><env count="12" seed="s" local="en">' +
      CITY +
      '<mix name="S" percent="50">' +
      '<case><data>${{City}}/north</data></case>' +
      '<case><data>${{City}}/south</data></case></mix></env>' +
      '<block><line><data>${{City}}|${{S}}</data></line></block></tdc>';
    const out = new TDC({ configString: config, now: NOW }).toString().trimEnd().split('\n');
    for (const line of out) {
      const [city, composed] = line.split('|');
      expect(composed?.startsWith(`${city ?? ''}/`)).toBe(true);
    }
  });

  it('applies the filters a <line> may use', () => {
    const out = rows(
      `${CITY}<mix name="S" percent="0">` +
        '<case><data>${{City}} plain</data></case>' +
        '<case><data>${{City|upper}} loud</data></case></mix>',
      4,
    );
    for (const line of out) {
      expect(line).toMatch(/^(ALPHA|BETA|GAMMA) loud$/);
    }
  });

  it('reads the row built-ins', () => {
    const out = rows(
      '<mix name="S" percent="100"><case><data>row ${{_count}}</data></case>' +
        '<case><data>never</data></case></mix>',
      3,
    );
    expect(out).toEqual(['row 1', 'row 2', 'row 3']);
  });

  it('leaves a column that is empty on this row empty, not marked', () => {
    // A declared column with no value here renders as nothing. Printing the
    // marker instead would read as a broken config rather than as an empty cell.
    const out = rows(
      '<sequence name="K"><gen type="text" value="a,b" percent="50,50"/></sequence>' +
        '<sequence name="Only" parent="K.a"><gen type="text" value="X"/></sequence>' +
        '<mix name="S" percent="100"><case><data>[${{Only}}]</data></case>' +
        '<case><data>never</data></case></mix>',
      6,
    );
    for (const line of out) {
      expect(line === '[X]' || line === '[]').toBe(true);
    }
    expect(out).toContain('[]');
  });

  it('means the same thing on the streaming engine', () => {
    const env =
      `${CITY}<mix name="S" percent="60">` +
      '<case><data>${{City}} North</data></case>' +
      '<case><data>${{City|upper}} South</data></case></mix>';
    expect(rows(env, 12, 'disk')).toEqual(rows(env, 12, 'memory'));
  });

  it('leaves plain text alone', () => {
    const out = rows(
      '<mix name="S" percent="100"><case><data>just text</data></case>' +
        '<case><data>never</data></case></mix>',
      2,
    );
    expect(out).toEqual(['just text', 'just text']);
  });
});

describe('a name inside a <case> that nobody declared', () => {
  it('TDC193 — refused rather than printed literally', () => {
    expect(
      codes(
        '<mix name="S" percent="60"><case><data>${{Nosuch}}</data></case>' +
          '<case><data>plain</data></case></mix>',
      ),
    ).toContain('TDC193');
  });

  it('says nothing when the name is declared', () => {
    expect(
      codes(
        `${CITY}<mix name="S" percent="60"><case><data>\${{City}}</data></case>` +
          '<case><data>plain</data></case></mix>',
      ),
    ).toEqual([]);
  });

  it('accepts a name declared BELOW the case that reads it', () => {
    // The deferred pass is the whole reason this is legal: mid-walk the column
    // does not exist yet, and refusing there would invent errors on configs
    // that work.
    expect(
      codes(
        '<mix name="S" percent="60"><case><data>${{City}}</data></case>' +
          `<case><data>plain</data></case></mix>${CITY}`,
      ),
    ).toEqual([]);
  });

  it('stands down when the document sets its own inject marker', () => {
    // A config generating a Handlebars template MEANS to emit `${{…}}`, and the
    // escape hatch is the same one the output block honours.
    expect(
      codes(
        '<mix name="S" percent="60"><case><data>${{Nosuch}}</data></case>' +
          '<case><data>plain</data></case></mix>',
        ' inject="[%]"',
      ),
    ).toEqual([]);
  });
});
