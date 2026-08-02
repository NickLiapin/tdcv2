import { describe, expect, it } from 'vitest';

import { parse, parseStrict, TdcParseError } from '../../src/parser/index.js';

describe('parser — basic smoke', () => {
  it('parses an empty document', () => {
    const result = parse('');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses a document consisting only of whitespace and comments', () => {
    const result = parse('\n  <!-- a comment -->\n  ');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses a minimal <tdc/> self-closing tag', () => {
    const result = parse('<tdc/>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses <tdc></tdc> open/close empty body', () => {
    const result = parse('<tdc></tdc>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses a tag with attributes', () => {
    const result = parse('<tdc version="0.01" comment="hello"/>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses nested tags', () => {
    const result = parse('<tdc><env count="10"/></tdc>');
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe('parser — <data> raw text', () => {
  it('parses a simple <data>text</data>', () => {
    const result = parse('<tdc><data>hello world</data></tdc>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses <data> containing non-tag special characters', () => {
    const result = parse('<tdc><data>{ a: "b", c: 42 }</data></tdc>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses <data> containing pipe and punctuation', () => {
    const result = parse('<tdc><data>| value, value |</data></tdc>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses empty <data></data>', () => {
    const result = parse('<tdc><data></data></tdc>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parses paired <data> containing a literal </data> marker', () => {
    const result = parse(
      '<tdc><data pair="doc">Example: <data>${{Name}}</data></data pair="doc"></tdc>',
    );
    expect(result.diagnostics).toHaveLength(0);
  });

  it('reports duplicate paired <data> values', () => {
    const result = parse(
      '<tdc><data pair="dup">a</data pair="dup"><data pair="dup">b</data pair="dup"></tdc>',
    );
    expect(result.diagnostics.some((d) => d.message.includes('duplicate <data pair="dup">'))).toBe(
      true,
    );
  });

  it('reports a mismatched paired <data> close tag', () => {
    const result = parse('<tdc><data pair="alpha">x</data pair="beta"></tdc>');
    expect(
      result.diagnostics.some((d) =>
        d.message.includes('expected </data pair="alpha">, got </data pair="beta">'),
      ),
    ).toBe(true);
  });
});

describe('parser — error reporting', () => {
  it('reports a diagnostic for an unclosed tag', () => {
    const result = parse('<tdc>');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('accepts mismatched open/close tag names at grammar level', () => {
    // Grammar-wise `<tdc></env>` is structurally valid: the end-tag is a
    // single literal token and the parser does not verify the name matches
    // the opener. Tag-name matching is a semantic validation that lives
    // at AST level, to be added in a later milestone.
    // See docs/vision/07-questions.md if this policy changes.
    const result = parse('<tdc></env>');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('parseStrict throws TdcParseError on any diagnostic', () => {
    expect(() => parseStrict('<tdc>')).toThrow(TdcParseError);
  });

  it('TdcParseError exposes all collected diagnostics', () => {
    try {
      parseStrict('<tdc>');
    } catch (err) {
      expect(err).toBeInstanceOf(TdcParseError);
      expect((err as TdcParseError).diagnostics.length).toBeGreaterThan(0);
      return;
    }
    throw new Error('Expected parseStrict to throw');
  });

  it('diagnostics carry line and column positions', () => {
    const result = parse('<tdc>\n  <invalid!>\n</tdc>');
    expect(result.diagnostics.length).toBeGreaterThan(0);
    const first = result.diagnostics[0];
    expect(first).toBeDefined();
    expect(first?.line).toBeGreaterThanOrEqual(1);
    expect(typeof first?.column).toBe('number');
  });
});
