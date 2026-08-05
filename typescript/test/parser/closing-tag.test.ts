/**
 * A closing tag that does not name the element it closes.
 *
 * `openCloseElement : LT name=NAME attr* GT content endTag=END_TAG ;` accepts
 * ANY name in the closing tag, and nothing downstream ever compared the two —
 * so `<sequence>…</gen>` was a valid document and `check` said so, in all five
 * implementations. The element was built under its opening name and the closing
 * tag was thrown away.
 *
 * The engine already refused this in the one place somebody wrote it down:
 * `<data pair="alpha">…</data pair="beta">` is named rather than left to the
 * lexer. These tests are that rule for ordinary tags.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';

const at = (source: string): string[] =>
  parse(source).diagnostics.map((d) => `${String(d.line)}:${String(d.column)} ${d.message}`);

const wrap = (body: string): string =>
  `<tdc><env count="2" seed="s" local="en">${body}</env>` +
  '<block><line><data>x</data></line></block></tdc>';

describe('a closing tag that names another element', () => {
  it('is refused, where before the document was valid', () => {
    const diagnostics = at(wrap('<sequence name="A"><gen type="text" value="a"/></gen>'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('</gen> closes <sequence>');
  });

  it('names the line the element was opened on, which is the half not under the caret', () => {
    const source =
      '<tdc>\n' +
      '  <env count="2" seed="s" local="en">\n' +
      '    <sequence name="A">\n' +
      '      <gen type="text" value="a"/>\n' +
      '    </gen>\n' +
      '  </env>\n' +
      '  <block><line><data>x</data></line></block>\n' +
      '</tdc>';
    expect(at(source)).toEqual(['5:4 </gen> closes <sequence>, which was opened on line 3']);
  });

  it('points at the closing tag, not at the element it belongs to', () => {
    // The fix is typed where the caret is. Pointing at the opening tag would
    // put it a screen away in a real config.
    const source = wrap('<sequence name="A"><gen type="text" value="a"/></gen>');
    const [only] = at(source);
    expect(only?.startsWith(`1:${String(source.indexOf('</gen>'))} `)).toBe(true);
  });
});

describe('what it must not say', () => {
  it('stays quiet on a document whose tags all match', () => {
    expect(at(wrap('<sequence name="A"><gen type="text" value="a"/></sequence>'))).toEqual([]);
  });

  it('stays quiet on a self-closing element, which has no closing tag to disagree', () => {
    expect(at(wrap('<sequence name="A"><gen type="text" value="a"/></sequence>'))).toEqual([]);
  });

  it('does not read <data> or <map> bodies, where a tag is literal text', () => {
    // `</gen>` inside <data> is output, not structure — the lexer hands the
    // body over as opaque text and this must not go looking inside it.
    const source =
      '<tdc><env count="2" seed="s" local="en"></env>' +
      '<block><line><data></gen></data></line></block></tdc>';
    expect(at(source)).toEqual([]);
  });
});

describe('one typo, one complaint', () => {
  it('reports the first mismatch only, not one per level it shifted', () => {
    // `</case>` closes the <mix>; every closing tag after it then lands on the
    // element one level out, so a naive check would say the same thing four
    // times about one typo.
    const source =
      '<tdc><env count="2" seed="s" local="en">' +
      '<mix name="M"><case><data>a</data></case></case>' +
      '</mix></env><block><line><data>x</data></line></block></tdc>';
    const diagnostics = at(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('</case> closes <mix>');
  });

  it('drops what the parser said about the wreckage after it', () => {
    // Left alone, ANTLR reports `extraneous input '</tdc>'` at the bottom of
    // the file — a true sentence about a tree that only went wrong higher up.
    const source =
      '<tdc>\n' +
      '  <env count="2" seed="s" local="en">\n' +
      '  </env>\n' +
      '  </block>\n' +
      '  <block><line><data>x</data></line></block>\n' +
      '</tdc>';
    expect(at(source)).toEqual(['4:2 </block> closes <tdc>, which was opened on line 1']);
  });

  it('keeps what the parser said BEFORE it, which is about another part of the file', () => {
    // A broken attribute on line 2 is not explained by a closing tag on line 5.
    const source =
      '<tdc>\n' +
      '  <env count="2" seed= local="en">\n' +
      '    <sequence name="A">\n' +
      '      <gen type="text" value="a"/>\n' +
      '    </gen>\n' +
      '  </env>\n' +
      '  <block><line><data>x</data></line></block>\n' +
      '</tdc>';
    const diagnostics = at(source);
    expect(diagnostics.length).toBeGreaterThan(1);
    expect(diagnostics[0]?.startsWith('2:')).toBe(true);
    expect(diagnostics.at(-1)).toContain('</gen> closes <sequence>');
  });
});
