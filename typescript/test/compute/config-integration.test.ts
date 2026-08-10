import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { parse } from '../../src/parser/parse.js';
import { luhnCheckDigit, weightedSum } from '../../src/presets/utils.js';
import { validate } from '../../src/validator/index.js';

/** Full INN: 9 random base digits + a computed weighted-sum check digit. */
const INN_CONFIG = `<tdc><env count="25" seed="inn-demo">
  <sequence name="Base"><gen type="number" value="100000000..999999999"/></sequence>
  <sequence name="Inn"><compute>
    <let name="check">
      <mod><mod>
        <reduce>
          <over><field name="Base"/></over>
          <init><int v="0"/></init>
          <do><add><acc/><multiply><current/>
            <at><in><list v="2,4,10,3,5,9,4,6,8"/></in><index><current_index/></index></at>
          </multiply></add></do>
        </reduce>
        <int v="11"/></mod><int v="10"/></mod>
    </let>
    <result><concat><field name="Base"/><use name="check"/></concat></result>
  </compute></sequence>
</env><block><line><data>\${{Inn}}</data></line></block></tdc>`;

/** Full payment card: 15 base digits + a computed Luhn check digit. */
const CARD_CONFIG = `<tdc><env count="25" seed="card-demo">
  <sequence name="Base"><gen type="number" value="100000000000000..999999999999999"/></sequence>
  <sequence name="Card"><compute>
    <let name="check">
      <mod><subtract><int v="10"/><mod>
        <reduce>
          <over><field name="Base"/></over>
          <init><int v="0"/></init>
          <do><add><acc/>
            <choose>
              <when>
                <test><equals>
                  <mod><current_index/><int v="2"/></mod>
                  <mod><add><length><field name="Base"/></length><int v="1"/></add><int v="2"/></mod>
                </equals></test>
                <then>
                  <let name="d"><multiply><current/><int v="2"/></multiply></let>
                  <choose>
                    <when><test><greater_than><use name="d"/><int v="9"/></greater_than></test>
                          <then><subtract><use name="d"/><int v="9"/></subtract></then></when>
                    <otherwise><use name="d"/></otherwise>
                  </choose>
                </then>
              </when>
              <otherwise><current/></otherwise>
            </choose>
          </add></do>
        </reduce>
        <int v="10"/></mod></subtract><int v="10"/></mod>
    </let>
    <result><concat><field name="Base"/><use name="check"/></concat></result>
  </compute></sequence>
</env><block><line><data>\${{Card}}</data></line></block></tdc>`;

function lines(output: string): string[] {
  return output.split('\n').filter((l) => l.length > 0);
}

function innCheck(base: string): string {
  return String((weightedSum(base, [2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11) % 10);
}

describe('compute inside a real config (INN)', () => {
  it('every rendered line is a valid 10-digit INN', () => {
    const out = lines(new TDC({ configString: INN_CONFIG }).toString());
    expect(out.length).toBe(25);
    for (const inn of out) {
      expect(inn).toMatch(/^\d{10}$/);
      expect(inn.slice(9)).toBe(innCheck(inn.slice(0, 9)));
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = new TDC({ configString: INN_CONFIG }).toString();
    const b = new TDC({ configString: INN_CONFIG }).toString();
    expect(a).toBe(b);
  });

  it('toArray() exposes the computed sequence alongside its input', () => {
    const rows = new TDC({ configString: INN_CONFIG }).toArray();
    expect(rows.length).toBe(25);
    for (const row of rows) {
      const base = row['Base'] as string;
      const inn = row['Inn'] as string;
      expect(inn).toBe(base + innCheck(base));
    }
  });
});

describe('compute inside a real config (Luhn card)', () => {
  it('every rendered line passes Luhn', () => {
    const out = lines(new TDC({ configString: CARD_CONFIG }).toString());
    expect(out.length).toBe(25);
    for (const card of out) {
      expect(card).toMatch(/^\d{16}$/);
      expect(card.slice(15)).toBe(String(luhnCheckDigit(card.slice(0, 15))));
    }
  });
});

describe('validator surfaces malformed compute in a config', () => {
  it('reports an unbound var (TDC182)', () => {
    const bad = `<tdc><env count="1" seed="x">
      <sequence name="A"><compute><result><use name="ghost"/></result></compute></sequence>
    </env><block><line><data>\${{A}}</data></line></block></tdc>`;
    const diags = validate(parse(bad).tree).diagnostics;
    expect(diags.some((d) => d.code === 'TDC182')).toBe(true);
  });

  it('reports a field that is not in scope (TDC182)', () => {
    const bad = `<tdc><env count="1" seed="x">
      <sequence name="A"><compute><result><field name="NotDeclared"/></result></compute></sequence>
    </env><block><line><data>\${{A}}</data></line></block></tdc>`;
    const diags = validate(parse(bad).tree).diagnostics;
    expect(diags.some((d) => d.code === 'TDC182')).toBe(true);
  });

  it('accepts a well-formed compute config with no diagnostics', () => {
    const diags = validate(parse(INN_CONFIG).tree).diagnostics;
    expect(diags).toEqual([]);
  });
});
