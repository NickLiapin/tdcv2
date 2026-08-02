import { describe, expect, it } from 'vitest';

import { TdcDiagnosticError } from '../../src/errors/index.js';
import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

/**
 * Render-time errors must funnel through `TdcDiagnosticError` with a
 * source location — the same channel as parser/validator errors — so
 * callers that invoke `render()` directly (bypassing validation) still
 * get a located, formattable error instead of a bare stack trace.
 *
 * The validator catches these same problems earlier for CLI/TDC-class
 * users; these tests exercise the render path directly to lock in the
 * defence-in-depth behaviour.
 */
describe('render-time errors → located TdcDiagnosticError', () => {
  const SOURCE = `<tdc>
  <env count="2" seed="x" inject="\${{%}}"></env>
  <block>
    <line><gen type="template" value="person.nope"/></line>
  </block>
</tdc>`;

  it('unknown template path throws a located diagnostic (TDC071)', () => {
    const tree = parseStrict(SOURCE);
    let caught: unknown;
    try {
      render(tree, { source: SOURCE, now: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TdcDiagnosticError);
    const err = caught as TdcDiagnosticError;
    const d = err.diagnostics[0];
    expect(d?.code).toBe('TDC071');
    expect(d?.source).toBe('render');
    // The offending <gen> is on line 4 of SOURCE.
    expect(d?.line).toBe(4);
    expect(d?.column).toBeGreaterThan(0);
    // Source is threaded so the formatter can show a snippet.
    expect(err.source).toBe(SOURCE);
  });

  it('missing <block> throws a located diagnostic (TDC002)', () => {
    const noBlock = `<tdc><env count="1" seed="x"></env></tdc>`;
    const tree = parseStrict(noBlock);
    let caught: unknown;
    try {
      render(tree, { source: noBlock, now: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TdcDiagnosticError);
    expect((caught as TdcDiagnosticError).diagnostics[0]?.code).toBe('TDC002');
  });
});
