import { describe, expect, it } from 'vitest';

import { MAX_ELEMENT_DEPTH } from '../../src/parser/depth.js';
import { parse } from '../../src/parser/index.js';

/**
 * Input depth is stack depth: the parser recurses once per nested element, so
 * without a ceiling a generated document with tens of thousands of nested tags
 * takes the process down (and hard-aborts the implementations whose stack
 * overflow is not recoverable). These tests pin the ceiling and, more
 * importantly, that crossing it is a refusal — not a crash.
 */
describe('parser — element nesting ceiling', () => {
  const nested = (depth: number): string => {
    // <tdc><env> are two levels; the sequences and the gen fill the rest.
    const sequences = depth - 3;
    return (
      '<tdc version="0.01"><env count="1" seed="s" local="en">' +
      '<sequence name="A">'.repeat(sequences) +
      '<gen type="text" value="x"/>' +
      '</sequence>'.repeat(sequences) +
      '</env><block><line><data>ok</data></line></block></tdc>'
    );
  };

  it(`accepts a document exactly ${String(MAX_ELEMENT_DEPTH)} elements deep`, () => {
    const result = parse(nested(MAX_ELEMENT_DEPTH));
    expect(result.diagnostics).toHaveLength(0);
  });

  it('refuses one level past the ceiling, naming the ceiling', () => {
    const result = parse(nested(MAX_ELEMENT_DEPTH + 1));
    expect(result.diagnostics).toHaveLength(1);
    const diagnostic = result.diagnostics[0];
    expect(diagnostic?.source).toBe('parser');
    expect(diagnostic?.message).toContain(`deeper than ${String(MAX_ELEMENT_DEPTH)} levels`);
    expect(diagnostic?.line).toBe(1);
  });

  it('refuses a 50000-deep document instead of overflowing the stack', () => {
    const bomb =
      '<tdc version="0.01"><env count="1" seed="s" local="en">' +
      '<sequence name="A">'.repeat(50000) +
      '</sequence>'.repeat(50000) +
      '</env><block><line><data>x</data></line></block></tdc>';
    const result = parse(bomb);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain('refusing a runaway document');
    // The refusal happens at the ceiling, so the tree is the empty fallback —
    // present (the LSP relies on that) and holding nothing.
    expect(result.tree.element()).toHaveLength(0);
  });
});
