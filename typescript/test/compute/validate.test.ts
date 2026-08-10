import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/index.js';
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

describe('checkCompute — valid trees produce no diagnostics', () => {
  it('accepts a well-formed reduce with acc/current', () => {
    const diags = check(
      '<compute><let name="s"><reduce><over><field name="base"/></over>' +
        '<init><int v="0"/></init><do><add><acc/><current/></add></do></reduce></let>' +
        '<result><use name="s"/></result></compute>',
      ['base'],
    );
    expect(diags).toEqual([]);
  });
});

describe('checkCompute — structural errors', () => {
  it('TDC180: unknown tag', () => {
    expect(codes(check('<compute><frobnicate/></compute>'))).toContain('TDC180');
  });

  it('TDC180: <param> is a phase-2 compute-def tag the runtime cannot evaluate', () => {
    const diags = check('<compute><result><param name="x"/></result></compute>');
    expect(codes(diags)).toContain('TDC180');
    // The hint must point at compute-def/use rather than read as a typo.
    expect(diags.find((d) => d.code === 'TDC180')?.hint ?? '').toMatch(/compute-def/);
  });

  it('TDC181: <current/> outside an iteration', () => {
    expect(codes(check('<compute><result><current/></result></compute>'))).toContain('TDC181');
  });

  it('TDC181: <acc/> outside a reduce', () => {
    expect(codes(check('<compute><result><acc/></result></compute>'))).toContain('TDC181');
  });

  it('TDC182: unbound var', () => {
    expect(codes(check('<compute><result><use name="ghost"/></result></compute>'))).toContain(
      'TDC182',
    );
  });

  it('TDC182: unknown field when knownFields is provided', () => {
    expect(
      codes(check('<compute><result><field name="nope"/></result></compute>', ['base'])),
    ).toContain('TDC182');
  });

  it('no TDC182 for a known field', () => {
    expect(
      codes(check('<compute><result><field name="base"/></result></compute>', ['base'])),
    ).not.toContain('TDC182');
  });

  it('TDC183: mod with wrong arity', () => {
    expect(codes(check('<compute><result><mod><int v="1"/></mod></result></compute>'))).toContain(
      'TDC183',
    );
  });

  it('TDC184: choose without otherwise', () => {
    expect(
      codes(
        check(
          '<compute><result><choose><when><test><equals><int v="1"/><int v="1"/></equals>' +
            '</test><then><int v="0"/></then></when></choose></result></compute>',
        ),
      ),
    ).toContain('TDC184');
  });

  it('TDC185: let name shadowing', () => {
    expect(
      codes(
        check(
          '<compute><let name="a"><int v="1"/></let><let name="a"><int v="2"/></let>' +
            '<result><use name="a"/></result></compute>',
        ),
      ),
    ).toContain('TDC185');
  });

  it('TDC186: unknown encode system', () => {
    expect(
      codes(check('<compute><result><encode as="base58"><str v="A"/></encode></result></compute>')),
    ).toContain('TDC186');
  });

  it('TDC187: each missing a required wrapper', () => {
    expect(
      codes(
        check('<compute><result><each><over><field name="b"/></over></each></result></compute>', [
          'b',
        ]),
      ),
    ).toContain('TDC187');
  });

  it('accepts a valid current-index inside a do body', () => {
    const diags = check(
      '<compute><result><each><over><field name="b"/></over>' +
        '<do><current_index/></do></each></result></compute>',
      ['b'],
    );
    expect(diags).toEqual([]);
  });
});

/**
 * Three rules the docs stated and nothing checked. Each let through a config
 * the documentation calls invalid, and each produced something rather than
 * failing — the quiet kind of wrong.
 */
describe('checkCompute — rules the docs promised but nothing enforced', () => {
  it('rejects a non-integer <int v> before the run (TDC188)', () => {
    for (const v of ['abc', '3.5', '', ' ']) {
      expect(codes(check(`<compute><result><int v="${v}"/></result></compute>`))).toContain(
        'TDC188',
      );
    }
  });

  it('still accepts integers, including negatives', () => {
    for (const v of ['0', '42', '-7']) {
      expect(check(`<compute><result><int v="${v}"/></result></compute>`)).toEqual([]);
    }
  });

  it('rejects <over> outside <each>/<reduce> (TDC181)', () => {
    expect(codes(check('<compute><result><over><str v="a"/></over></result></compute>'))).toContain(
      'TDC181',
    );
  });

  it('still accepts <over> inside <each> and <reduce>', () => {
    expect(
      check(
        '<compute><result><each><over><list v="1,2"/></over>' +
          '<do><current/></do></each></result></compute>',
      ),
    ).toEqual([]);
  });

  // The tags that share a fall-through arm with <over> in the walker. An
  // earlier version of this check was inserted mid-chain and broke every one
  // of them; the Luhn integration test caught it, but only by luck of covering
  // <mod>. Pin the whole arm.
  it("leaves the tags that share <over>'s switch arm alone", () => {
    const cases = [
      '<mod><int v="7"/><int v="3"/></mod>',
      '<slice><str v="abcdef"/></slice>',
      '<replace><str v="a-b"/></replace>',
      '<trim><str v=" a "/></trim>',
      '<group><str v="abc"/></group>',
    ];
    for (const body of cases) {
      expect(codes(check(`<compute><result>${body}</result></compute>`))).not.toContain('TDC181');
    }
  });

  it('rejects a second <result> (TDC189)', () => {
    expect(
      codes(check('<compute><result><int v="1"/></result><result><int v="2"/></result></compute>')),
    ).toContain('TDC189');
  });

  it('accepts exactly one <result>', () => {
    expect(check('<compute><result><int v="1"/></result></compute>')).toEqual([]);
  });
});
