/**
 * The parts a compute tag reads by NAME, and what happens to the rest.
 *
 * `<choose>`, `<when>`, `<each>`, `<reduce>` and `<at>` do not evaluate their
 * children in order — each looks up the slots it knows and ignores the others.
 * The validator matched that shape too closely: it descended only into the known
 * slots, so a misspelled slot name was never walked, never validated, and never
 * run. `check` called it valid and the run quietly took the other branch.
 *
 * Every expectation below was measured against the UNFIXED engine first; the
 * numbers in the Luhn test are what it actually produced.
 */

import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/index.js';
import { TDC } from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import { elementKind } from '../../src/processor/walk.js';
import { checkCompute } from '../../src/validator/compute.js';

function check(computeXml: string, knownFields?: string[]): Diagnostic[] {
  const result = parse(computeXml);
  const el = result.tree.element()[0];
  if (!el) throw new Error('no element');
  const k = elementKind(el);
  if (k?.kind !== 'open') throw new Error('expected <compute>');
  const diags: Diagnostic[] = [];
  checkCompute(k.node, diags, knownFields ? new Set(knownFields) : undefined);
  return diags;
}

const codes = (diags: Diagnostic[]): string[] => diags.map((d) => d.code ?? '');

function render(body: string, count = 1): string[] {
  return new TDC({
    configString:
      `<tdc><env count="${String(count)}" seed="s" local="en">` +
      `<sequence name="X"><compute>${body}</compute></sequence></env>` +
      '<block><line><data>${{X}}</data></line></block></tdc>',
  })
    .toString()
    .trimEnd()
    .split('\n');
}

describe('a slot name the tag does not have', () => {
  it.each([
    [
      'choose',
      '<choose><wen><test><is_digit><str v="1"/></is_digit></test>' +
        '<then><str v="A"/></then></wen><otherwise><str v="B"/></otherwise></choose>',
      '<wen>',
    ],
    [
      'when',
      '<choose><when><test><is_digit><str v="1"/></is_digit></test>' +
        '<hten><str v="A"/></hten><then><str v="A"/></then></when>' +
        '<otherwise><str v="B"/></otherwise></choose>',
      '<hten>',
    ],
    [
      'each',
      '<join sep=""><each><over><str v="ab"/></over><do><current/></do>' +
        '<oops><str v="z"/></oops></each></join>',
      '<oops>',
    ],
    [
      'reduce',
      '<reduce><over><str v="1"/></over><init><int v="0"/></init>' +
        '<do><acc/></do><junk><int v="1"/></junk></reduce>',
      '<junk>',
    ],
    [
      'at',
      '<at><in><list v="1,2"/></in><index><int v="0"/></index>' +
        '<defualt><int v="9"/></defualt></at>',
      '<defualt>',
    ],
  ])('is TDC180 inside <%s>', (_tag, body, stray) => {
    const diags = check(`<compute><result>${body}</result></compute>`);
    expect(codes(diags)).toContain('TDC180');
    expect(diags.map((d) => d.message).join(' ')).toContain(stray);
  });

  it('says only the true thing — the stray part is not walked as a value slot', () => {
    // Walking it reported the perfectly correct <test><equals> inside as "a
    // predicate in a value position": a second error on markup needing no change,
    // which vanishes once the first is fixed.
    const diags = check(
      '<compute><result><choose><wen><test><equals><int v="1"/><int v="1"/></equals></test>' +
        '<then><str v="A"/></then></wen><otherwise><str v="B"/></otherwise></choose></result></compute>',
    );
    expect(codes(diags)).toEqual(['TDC180']);
  });

  it('leaves the correct spelling alone', () => {
    const diags = check(
      '<compute><result><choose><when><test><is_digit><str v="1"/></is_digit></test>' +
        '<then><str v="A"/></then></when><otherwise><str v="B"/></otherwise></choose></result></compute>',
    );
    expect(diags).toEqual([]);
  });
});

describe('<acc/> inside an <each> nested in a <reduce>', () => {
  it('reads the enclosing accumulator instead of dying mid-run', () => {
    // Before: `check` passed it, then the run threw a bare
    // "<acc/> used outside a <reduce>" with no code, line or file.
    expect(
      render(
        '<result><reduce><over><str v="12"/></over><init><int v="7"/></init>' +
          '<do><join sep=""><each><over><str v="3"/></over><do><acc/></do></each></join></do>' +
          '</reduce></result>',
      ),
    ).toEqual(['7']);
  });

  it('still replaces <current/> with the inner element', () => {
    expect(
      render(
        '<result><reduce><over><str v="12"/></over><init><str v=""/></init>' +
          '<do><join sep=""><each><over><str v="ab"/></over><do><current/></do></each></join></do>' +
          '</reduce></result>',
      ),
    ).toEqual(['ab']);
  });
});

describe('an attribute the engine cannot use', () => {
  it('refuses a <group size=> that is not a positive whole number', () => {
    // Measured before: size="abc" left the value ungrouped in silence, and
    // size="2.5" produced "12 34 567" — grouped by neither 2 nor 3.
    for (const size of ['abc', '0', '-2', '2.5', '']) {
      expect(
        codes(
          check(
            `<compute><result><group size="${size}"><str v="1234567"/></group></result></compute>`,
          ),
        ),
      ).toContain('TDC188');
    }
  });

  it('accepts a whole number, and groups by it', () => {
    expect(
      check('<compute><result><group size="3"><str v="1234567"/></group></result></compute>'),
    ).toEqual([]);
    expect(render('<result><group size="3"><str v="1234567"/></group></result>')).toEqual([
      '1 234 567',
    ]);
  });

  it('refuses a <list> written both ways at once', () => {
    // Measured before: v= won and the children were dropped without a word.
    expect(
      codes(
        check(
          '<compute><result><join sep="-"><list v="1,2"><int v="9"/></list></join></result></compute>',
        ),
      ),
    ).toContain('TDC189');
  });

  it('accepts either spelling on its own', () => {
    expect(
      check('<compute><result><join sep="-"><list v="1,2"/></join></result></compute>'),
    ).toEqual([]);
    expect(
      check(
        '<compute><result><join sep="-"><list><int v="9"/><int v="8"/></list></join></result></compute>',
      ),
    ).toEqual([]);
  });
});

describe('an error message names the type it actually got', () => {
  it('calls a number a number, not a list', () => {
    expect(() =>
      render('<result><join sep=","><split sep="|"><int v="12"/></split></join></result>'),
    ).toThrow(/<split>: expected a string, got a number/);
  });
});
