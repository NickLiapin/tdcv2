/**
 * Three places the engine used to say too little, or say it about the wrong thing.
 *
 * These came from a bench that ran small local models against the documentation
 * and measured what they did with each refusal. The finding worth keeping: a
 * NAMED diagnostic carrying a list of what is allowed gets fixed on the first
 * attempt, and a message without one gets circled for four. Every case here is
 * about supplying that list, or about not burying it under a consequence.
 */

import { describe, expect, it } from 'vitest';

import { TdcDiagnosticError } from '../../src/errors/TdcDiagnosticError.js';
import { TDC } from '../../src/index.js';

/** Every diagnostic a config raises, as `CODE: message | hint`. */
const report = (source: string): string[] => {
  try {
    new TDC({ configString: source });
    return [];
  } catch (err) {
    if (!(err instanceof TdcDiagnosticError)) throw err;
    return err.diagnostics.map((d) => `${d.code ?? '-'}: ${d.message} | ${d.hint ?? ''}`);
  }
};

describe('an invented tag inside <sequence>', () => {
  const invented = `<tdc><env count="3" seed="p" local="en">
    <sequence name="A">
      <gen type="number" value="1..9"/>
      <anomaly_factor min="25" max="65"/>
    </sequence>
  </env><block><line><data>\${{A}}</data></line></block></tdc>`;

  it('is refused, where it used to validate and run', () => {
    // The exact shape that cost a model four attempts: `check` said "is valid",
    // exit 0, and the run went ahead as though <anomaly_factor> had done
    // something. <env> has always answered this; <sequence> was the last
    // container with no list of its own.
    const codes = report(invented);
    expect(codes.some((c) => c.startsWith('TDC010'))).toBe(true);
  });

  it('names what a sequence WILL take — the part a reader acts on', () => {
    expect(report(invented)[0]).toContain(
      'Allowed inside <sequence>: compute, data, distinct, gen.',
    );
  });

  it('still accepts every legitimate body', () => {
    // The risk in this change was never the mechanism, it was the LIST: too
    // short and working configs start being refused, which is worse than the
    // silence it replaces. One of each, in one sequence.
    const ok = `<tdc><env count="3" seed="p" local="en">
      <sequence name="A"><gen type="number" value="1..9"/></sequence>
      <sequence name="B"><data name="k">x</data><gen name="n" type="number" value="1..9"/></sequence>
      <sequence name="C"><distinct><gen name="p" type="number" value="1..9"/><gen name="q" type="number" value="1..9"/></distinct></sequence>
      <sequence name="D"><compute><result><join sep="-"><in><list v="10,20,30"/></in></join></result></compute></sequence>
    </env><block><line><data>\${{A}}|\${{B}}|\${{C}}|\${{D}}</data></line></block></tdc>`;
    expect(report(ok)).toEqual([]);
  });
});

describe('a document that did not parse', () => {
  // An unpaired </gen> tears the tree; <block> falls out of it with everything
  // else, and the run used to report "no <block> child" — about a <block>
  // sitting in plain sight in the very line it printed.
  const torn =
    '<tdc><env count="3" seed="p" local="en"><sequence name="A">' +
    '<gen type="number" value="1..9"/></gen></sequence></env>' +
    '<block><line><data>${{A}}</data></line></block></tdc>';

  it('reports the parse failure and nothing derived from the wreckage', () => {
    const codes = report(torn);
    expect(codes.every((c) => c.startsWith('TDC001'))).toBe(true);
    // TDC002 was the most common refusal on the bench and never once the cause.
    expect(codes.some((c) => c.startsWith('TDC002'))).toBe(false);
  });

  it('says why nothing else was checked', () => {
    expect(report(torn)[0]).toContain('did not parse');
  });

  it('carries a code, rather than borrowing one from its own fallout', () => {
    // This contract existed before and was met by the TDC002 above — a check
    // satisfied by the very thing it was meant to rule out.
    expect(report(torn)[0]?.startsWith('TDC001')).toBe(true);
  });
});

describe('a known tag in the wrong container', () => {
  it('says where it belongs AND what the container takes', () => {
    const misplaced =
      '<tdc><env count="3" seed="p" local="en">' +
      '<sequence name="A"><gen type="number" value="1..9"/></sequence></env>' +
      '<block><row><line><data>${{A}}</data></line></row></block></tdc>';
    // "Move <row> to a valid location" does not say where. TDC010 in the same
    // situation prints the list, and that list is what gets read and acted on.
    expect(report(misplaced)[0]).toContain('Allowed inside <block>: line, data.');
  });
});

/**
 * The same invented tag, in every container that has one.
 *
 * Written as a table because the fault it guards was never in any single
 * container — it was that eight of them answered and five did not, and the
 * eight that did used three different wordings for one mistake. A model reading
 * three shapes learns three rules; a table is the only way to keep them one.
 */
describe('an invented tag is refused wherever it appears', () => {
  const BOG = '<bogus_tag/>';
  const SEQ = '<sequence name="A"><gen type="number" value="1..9"/></sequence>';
  const containers: readonly (readonly [string, string])[] = [
    [
      'tdc',
      `<tdc>${BOG}<env count="2" seed="p" local="en">${SEQ}</env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'env',
      `<tdc><env count="2" seed="p" local="en">${BOG}${SEQ}</env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'sequence',
      `<tdc><env count="2" seed="p" local="en"><sequence name="A"><gen type="number" value="1..9"/>${BOG}</sequence></env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'block',
      `<tdc><env count="2" seed="p" local="en">${SEQ}</env><block>${BOG}<line><data>x</data></line></block></tdc>`,
    ],
    [
      'line',
      `<tdc><env count="2" seed="p" local="en">${SEQ}</env><block><line>${BOG}<data>x</data></line></block></tdc>`,
    ],
    [
      'mix',
      `<tdc><env count="2" seed="p" local="en"><mix name="M" percent="50,50">${BOG}<case><data>a</data></case><case><data>b</data></case></mix></env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'case',
      `<tdc><env count="2" seed="p" local="en"><mix name="M" percent="50,50"><case><data>a</data>${BOG}</case><case><data>b</data></case></mix></env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'switch',
      `<tdc><env count="2" seed="p" local="en"><sequence name="K"><gen type="text" value="a,b"/></sequence><switch name="S" on="K">${BOG}<case is="a"><data>1</data></case><default><data>2</data></default></switch></env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'distinct',
      `<tdc><env count="2" seed="p" local="en"><sequence name="A"><distinct><gen name="p" type="number" value="1..9"/><gen name="q" type="number" value="1..9"/>${BOG}</distinct></sequence></env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'before',
      `<tdc><env count="2" seed="p" local="en"><before>${BOG}<line><data>h</data></line></before>${SEQ}</env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'gen',
      `<tdc><env count="2" seed="p" local="en"><sequence name="A"><gen type="number" value="1..9">${BOG}</gen></sequence></env><block><line><data>x</data></line></block></tdc>`,
    ],
    [
      'compute',
      `<tdc><env count="2" seed="p" local="en"><sequence name="A"><compute><result><join sep="-"><in><list v="10,20"/>${BOG}</in></join></result></compute></sequence></env><block><line><data>x</data></line></block></tdc>`,
    ],
  ];

  for (const [where, source] of containers) {
    it(`<${where}> says so, and says what it does take`, () => {
      const found = report(source).filter((d) => d.includes('bogus_tag'));
      expect(found.length, `<${where}> stayed silent`).toBeGreaterThan(0);
      expect(found[0], `<${where}> used its own wording`).toContain(`Allowed inside <${where}>:`);
    });
  }

  it('leaves <data> alone — a tag there is output text, not a mistake', () => {
    // `<data>x<b/>y</data>` renders `x<b/>y`, which is how a config emits XML or
    // HTML. Refusing it would take that away to catch a typo.
    const inData =
      '<tdc><env count="2" seed="p" local="en">' +
      '<sequence name="A"><gen type="number" value="1..9"/></sequence></env>' +
      '<block><line><data>x<bogus_tag/>y</data></line></block></tdc>';
    expect(report(inData)).toEqual([]);
    expect(new TDC({ configString: inData }).toString().split('\n')[0]).toBe('x<bogus_tag/>y');
  });
});
