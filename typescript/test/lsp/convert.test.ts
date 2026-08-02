import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/diagnostic.js';
import { toLspDiagnostic, toLspRange, toLspSeverity } from '../../src/lsp/convert.js';
import { Severity } from '../../src/lsp/types.js';

function diag(over: Partial<Diagnostic>): Diagnostic {
  return {
    severity: 'error',
    source: 'validator',
    line: 1,
    column: 0,
    message: 'boom',
    ...over,
  };
}

describe('toLspRange', () => {
  it('shifts 1-based line to 0-based, passes 0-based column through', () => {
    // line 3, column 5, exclusive end column 9 → LSP (2,5)-(2,9)
    expect(toLspRange(diag({ line: 3, column: 5, endLine: 3, endColumn: 9 }))).toEqual({
      start: { line: 2, character: 5 },
      end: { line: 2, character: 9 },
    });
  });

  it('underlines a single character when no explicit end', () => {
    expect(toLspRange(diag({ line: 1, column: 4 }))).toEqual({
      start: { line: 0, character: 4 },
      end: { line: 0, character: 5 },
    });
  });

  it('clamps so the range never goes negative and end >= start', () => {
    const r = toLspRange(diag({ line: 1, column: 0, endLine: 1, endColumn: 0 }));
    expect(r.start).toEqual({ line: 0, character: 0 });
    expect(r.end.character).toBeGreaterThanOrEqual(r.start.character);
  });

  it('spans multiple lines when endLine differs', () => {
    expect(toLspRange(diag({ line: 2, column: 1, endLine: 4, endColumn: 3 }))).toEqual({
      start: { line: 1, character: 1 },
      end: { line: 3, character: 3 },
    });
  });
});

describe('toLspSeverity', () => {
  it('maps error → Error and warning → Warning', () => {
    expect(toLspSeverity('error')).toBe(Severity.Error);
    expect(toLspSeverity('warning')).toBe(Severity.Warning);
  });
});

describe('toLspDiagnostic', () => {
  it('folds suggestion and hint into the message and keeps the code + source', () => {
    const d = toLspDiagnostic(
      diag({
        message: 'unknown template path "x"',
        suggestion: 'did you mean "person.name"?',
        hint: 'Known paths: …',
        code: 'TDC071',
      }),
    );
    expect(d.source).toBe('tdc');
    expect(d.code).toBe('TDC071');
    expect(d.message).toContain('unknown template path');
    expect(d.message).toContain('did you mean');
    expect(d.message).toContain('Known paths');
    expect(d.severity).toBe(Severity.Error);
  });

  it('omits code when absent', () => {
    expect(toLspDiagnostic(diag({})).code).toBeUndefined();
  });
});
