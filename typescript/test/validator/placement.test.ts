import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

/**
 * The PLACEMENT CONTRACT — what tag may live inside what. The grammar lets any
 * element nest anywhere, so the validator owns these rules. This file pins the
 * whole contract so a regression (e.g. a construct silently accepted in the
 * wrong place) fails the build.
 *
 * Homes:
 *   <gen>      → <sequence>, or a <case> of a <mix>/<switch>   (never loose)
 *   <mix>      → directly in <env>, or nested in a <case>
 *   <switch>   → directly in <env>
 *   <case>     → inside a <mix> or a <switch>
 *   <map>      → inside a <switch>
 *   <default>  → inside a <switch>
 *   <line>     → inside a <block> (or a before/after fixture)
 *   <data>     → inside a <line>/<case>/fixture
 * A misplaced KNOWN construct is TDC013 (or TDC131/TDC132 specifically for a
 * <line>, which pre-date this pass).
 */

const OUT = '<block><line><data>x</data></line></block>';
/** A <tdc> whose <env> body is `envBody`. */
const doc = (envBody: string, block = OUT) =>
  `<tdc><env count="2" seed="s">${envBody}</env>${block}</tdc>`;
/** A <tdc> whose <block> body is `blockBody` (env is empty). */
const blockDoc = (blockBody: string) =>
  `<tdc><env count="2" seed="s"></env><block>${blockBody}</block></tdc>`;
/** A <tdc> whose single <line> holds `lineBody`. */
const lineDoc = (lineBody: string) => blockDoc(`<line>${lineBody}</line>`);

/** Validation codes for a source that MUST parse cleanly (placement is semantic). */
function vcodes(src: string): (string | undefined)[] {
  const p = parse(src);
  expect(p.diagnostics, `should parse cleanly: ${src}`).toEqual([]);
  return validate(p.tree).diagnostics.map((d) => d.code);
}

const SEQ = '<sequence name="G"><gen type="text" value="a,b"/></sequence>';

describe('placement — <gen> lives only in <sequence> / <case>', () => {
  it('accepts a <gen> in a <sequence>', () => {
    expect(vcodes(doc(SEQ))).toEqual([]);
  });
  it('accepts a <gen> in a <mix> <case>', () => {
    expect(vcodes(doc('<mix name="M"><case><gen type="text" value="a"/></case></mix>'))).toEqual(
      [],
    );
  });
  it('rejects a <gen> loose in <env> (TDC013)', () => {
    expect(vcodes(doc('<gen type="text" value="a"/>'))).toContain('TDC013');
  });
  it('rejects a <gen> loose in <block> — was silently accepted (TDC013)', () => {
    expect(vcodes(blockDoc('<gen type="text" value="a"/>'))).toContain('TDC013');
  });
  it('rejects a <gen> in a <line> (TDC131)', () => {
    expect(vcodes(lineDoc('<gen type="text" value="a"/>'))).toContain('TDC131');
  });
  it('rejects a <gen> loose in <tdc> (TDC013)', () => {
    expect(vcodes(`<tdc><gen type="text" value="a"/><env count="2"></env>${OUT}</tdc>`)).toContain(
      'TDC013',
    );
  });
});

describe('placement — <mix> / <switch> are env-level constructs', () => {
  it('accepts a <mix> at env level', () => {
    expect(vcodes(doc('<mix name="M"><case><data>a</data></case></mix>'))).toEqual([]);
  });
  it('accepts a <switch> at env level', () => {
    expect(vcodes(doc(`${SEQ}<switch name="S" on="G"><map>a:1</map></switch>`))).toEqual([]);
  });
  it('accepts a nested <mix> inside a <case>', () => {
    expect(
      vcodes(doc('<mix name="M"><case><mix><case><data>a</data></case></mix></case></mix>')),
    ).toEqual([]);
  });
  it('rejects a <mix> in a <sequence> — clear TDC013, not a confusing "no gen"', () => {
    const codes = vcodes(
      doc('<sequence name="S"><mix><case><data>a</data></case></mix></sequence>'),
    );
    expect(codes).toContain('TDC013');
    expect(codes).not.toContain('TDC036');
  });
  it('rejects a <mix> in a <line> (TDC132)', () => {
    expect(vcodes(lineDoc('<mix><case><data>a</data></case></mix>'))).toContain('TDC132');
  });
  it('rejects a <switch> in a <line> (TDC132)', () => {
    expect(vcodes(lineDoc('<switch name="S" on="x"><map>a:1</map></switch>'))).toContain('TDC132');
  });
  it('rejects a <mix> loose in <block> (TDC013)', () => {
    expect(vcodes(blockDoc('<mix name="M"><case><data>a</data></case></mix>'))).toContain('TDC013');
  });
});

describe('placement — <case> / <map> / <default> belong to <mix> / <switch>', () => {
  it('rejects a <case> in <env>, <line>, and <block>', () => {
    expect(vcodes(doc('<case><data>a</data></case>'))).toContain('TDC013');
    expect(vcodes(lineDoc('<case><data>a</data></case>'))).toContain('TDC013');
    expect(vcodes(blockDoc('<case><data>a</data></case>'))).toContain('TDC013');
  });
  it('rejects a <map> anywhere outside <switch> — was fully invisible before', () => {
    expect(vcodes(doc('<map>a:1</map>')), 'in <env>').toContain('TDC013');
    expect(vcodes(lineDoc('<map>a:1</map>')), 'in <line>').toContain('TDC013');
    expect(vcodes(doc('<sequence name="S"><map>a:1</map></sequence>')), 'in <sequence>').toContain(
      'TDC013',
    );
    expect(vcodes(doc('<mix name="M"><map>a:1</map></mix>')), 'in <mix> not <case>').toContain(
      'TDC013',
    );
    expect(vcodes(doc('<mix name="M"><case><map>a:1</map></case></mix>')), 'in a <case>').toContain(
      'TDC013',
    );
  });
  it('rejects a <default> outside <switch>', () => {
    expect(vcodes(doc('<default><data>a</data></default>'))).toContain('TDC013');
  });
  it('accepts <map> / <case> / <default> inside a <switch>', () => {
    expect(
      vcodes(
        doc(
          `${SEQ}<switch name="S" on="G"><map>a:1</map>` +
            `<case is="b"><data>Y</data></case><default><data>?</data></default></switch>`,
        ),
      ),
    ).toEqual([]);
  });
});

describe('placement — <line> belongs to <block>', () => {
  it('accepts a <line> in a <block>', () => {
    expect(vcodes(blockDoc('<line><data>x</data></line>'))).toEqual([]);
  });
  it('rejects a bare <line> in <env> (TDC013)', () => {
    expect(vcodes(doc('<line><data>x</data></line>'))).toContain('TDC013');
  });
});

describe('placement — a full valid document with all constructs is clean', () => {
  it('sequence + conditional + mix + switch together', () => {
    const src = doc(
      `<sequence name="Gender"><gen type="text" value="Man,Woman" percent="42,58"/></sequence>` +
        `<sequence name="Name"><gen if="Gender.Man" type="template" value="person.male.firstName"/>` +
        `<gen type="template" value="person.female.firstName"/></sequence>` +
        `<mix name="Code" percent="25,70"><case><data>1</data></case><case><data>2</data></case>` +
        `<case><data>3</data></case></mix>` +
        `<switch name="Label" on="Gender"><case is="Man"><data>M</data></case>` +
        `<case is="Woman"><data>W</data></case></switch>`,
      '<block><line><data>${{Name}} ${{Code}} ${{Label}}</data></line></block>',
    );
    expect(vcodes(src)).toEqual([]);
  });
});

describe('parser robustness — whitespace & newlines', () => {
  const parses = (src: string) => parse(src).diagnostics.length === 0;

  it('accepts attributes spread across several lines', () => {
    expect(
      parses(doc('<sequence name="S"><gen\n  type="text"\n  value="a,b"\n/></sequence>')),
    ).toBe(true);
  });
  it('accepts a newline before the closing />', () => {
    expect(parses(doc('<sequence name="S"><gen type="text" value="a"\n  /></sequence>'))).toBe(
      true,
    );
  });
  it('accepts leading/trailing whitespace and blank lines around the doc', () => {
    expect(parses(`\n\n   ${doc(SEQ)}   \n\n`)).toBe(true);
  });
  it('rejects a space inside a tag name (<ge n>)', () => {
    expect(parses(doc('<sequence name="S"><ge n type="text" value="a"/></sequence>'))).toBe(false);
  });
  it('rejects an unclosed tag (<gen> with no /> or </gen>)', () => {
    expect(parses(doc('<sequence name="S"><gen type="text" value="a"></sequence>'))).toBe(false);
  });
});

/**
 * Fixtures hold literal text; generators do not run in them. Nothing enforced
 * that, so a `<gen>` inside one was accepted in silence and emitted the range
 * MINIMUM — `value="500..999"` produced `500` on every card and every seed.
 * A constant that looks generated is the worst of the three options.
 */
describe('placement — fixtures are literal text', () => {
  const FIXTURES = [
    'before',
    'after',
    'before_block',
    'after_block',
    'delimiter_block',
    'before_line',
    'after_line',
    'delimiter_line',
  ] as const;

  for (const tag of FIXTURES) {
    it(`rejects a <gen> inside <${tag}> (TDC131)`, () => {
      const body = `<${tag}><line><data>x</data><gen type="number" value="500..999"/></line></${tag}>`;
      expect(vcodes(doc(body + SEQ))).toContain('TDC131');
    });
  }

  it('rejects a <mix> and a <switch> in a fixture too', () => {
    expect(
      vcodes(
        doc('<before><line><mix name="M"><case><data>a</data></case></mix></line></before>' + SEQ),
      ),
    ).toContain('TDC131');
  });

  it('still accepts plain text in every fixture', () => {
    const body = FIXTURES.map((t) => `<${t}><line><data>[${t}]</data></line></${t}>`).join('');
    expect(vcodes(doc(body + SEQ))).toEqual([]);
  });
});

/**
 * `<env count="3" seed="demo"/>` parsed and then dropped every attribute: the
 * run produced the DEFAULT ten rows on a RANDOM seed, warning only about the
 * seed. Reproducibility is the core promise, so the spelling that silently
 * discards it has to be refused.
 */
describe('placement — <env> and <block> cannot be self-closing', () => {
  it('rejects a self-closing <env/> (TDC014)', () => {
    expect(vcodes('<tdc><env count="3" seed="demo"/>' + OUT + '</tdc>')).toContain('TDC014');
  });

  it('rejects a self-closing <block/> (TDC014)', () => {
    expect(vcodes('<tdc><env count="3" seed="demo"></env><block/></tdc>')).toContain('TDC014');
  });

  it('accepts the paired spelling with no children', () => {
    expect(vcodes('<tdc><env count="3" seed="demo"></env>' + OUT + '</tdc>')).toEqual([]);
  });
});

/**
 * `${{Nmae}}` with no such sequence used to reach the OUTPUT verbatim — the
 * seven characters landed in the data. In CSV that is at least visibly wrong;
 * in Parquet it goes into a typed UTF8 column and reads like a real string. A
 * guide in this repo referenced an undeclared `${{Client}}` and shipped 50 000
 * rows that way before anyone noticed.
 */
describe('placement — an unknown ${{…}} reference is refused', () => {
  it('rejects a misspelled sequence name (TDC193)', () => {
    expect(vcodes(doc(SEQ, '<block><line><data>${{Nmae}}</data></line></block>'))).toContain(
      'TDC193',
    );
  });

  it('accepts declared sequences, builtins and compound fields', () => {
    const compound =
      '<sequence name="P"><gen name="First" type="text" value="a"/>' +
      '<gen name="Last" type="text" value="b"/></sequence>';
    const out =
      '<block><line><data>${{G}} ${{_count}} ${{_total}} ${{P.First}} ${{P.Last}}</data></line></block>';
    expect(vcodes(doc(SEQ + compound, out))).toEqual([]);
  });

  it('accepts a name minted by anomaly_flag', () => {
    const seq =
      '<sequence name="V"><gen type="number" value="1..9" anomaly="0.1" anomaly_flag="Bad"/></sequence>';
    expect(vcodes(doc(seq, '<block><line><data>${{V}};${{Bad}}</data></line></block>'))).toEqual(
      [],
    );
  });

  it('looks through a filter to the name', () => {
    expect(vcodes(doc(SEQ, '<block><line><data>${{G | upper}}</data></line></block>'))).toEqual([]);
    expect(
      vcodes(doc(SEQ, '<block><line><data>${{Ghost | upper}}</data></line></block>')),
    ).toContain('TDC193');
  });

  // Emitting a literal ${{…}} is a real use (generating configs, Actions files,
  // Handlebars). A custom inject= already covers it, so the check stands down.
  it('stands down when inject is not the default', () => {
    const src =
      `<tdc><env count="2" seed="s" inject="<<%>>">${SEQ}</env>` +
      `<block><line><data>\${{NotASequence}} <<G>></data></line></block></tdc>`;
    const p = parse(src);
    expect(p.diagnostics).toEqual([]);
    expect(validate(p.tree).diagnostics.map((d) => d.code)).not.toContain('TDC193');
  });
});
