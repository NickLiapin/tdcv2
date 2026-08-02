import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/diagnostic.js';
import { formatDiagnostic, formatDiagnostics } from '../../src/errors/format.js';

const SOURCE = `<tdc>
    <env count="5">
        <sequence name="X">
            <gen type="template" value="person.male.first_name"/>
        </sequence>
    </env>
    <block><line><data>hi</data></line></block>
</tdc>`;

describe('formatDiagnostic — snippet rendering', () => {
  it('renders header, location, snippet with caret, and hint', () => {
    const d: Diagnostic = {
      severity: 'error',
      source: 'validator',
      line: 4,
      column: 40,
      endLine: 4,
      endColumn: 62,
      message: 'unknown template path "person.male.first_name"',
      suggestion: 'did you mean "person.male.firstName"?',
      hint: 'known paths: person.male.firstName, person.gender',
    };
    const out = formatDiagnostic(d, SOURCE, { filename: 'demo.xml' });
    expect(out).toContain('error: unknown template path "person.male.first_name"');
    expect(out).toContain(' --> demo.xml:4:41');
    expect(out).toContain('<gen type="template" value="person.male.first_name"/>');
    expect(out).toContain('^^^^^^^^^^^^^^^^^^^^^^');
    expect(out).toContain('help: did you mean "person.male.firstName"?');
    expect(out).toContain('note: known paths: person.male.firstName');
  });

  it('falls back to header-only when no source is provided', () => {
    const d: Diagnostic = {
      severity: 'warning',
      source: 'validator',
      line: 1,
      column: 0,
      message: 'something is off',
    };
    const out = formatDiagnostic(d);
    expect(out).toContain('warning: something is off');
    expect(out).toContain(' --> <input>:1:1');
    // No pipe-gutter snippet when source is absent.
    expect(out.split('\n').filter((l) => l.includes('|'))).toHaveLength(0);
  });

  it('underlines at least one character even on zero-width ranges', () => {
    const d: Diagnostic = {
      severity: 'error',
      source: 'validator',
      line: 1,
      column: 0,
      message: 'zero-width',
    };
    const out = formatDiagnostic(d, '<tdc>');
    expect(out).toContain('^');
  });

  it('gutter width adapts to 2-digit line numbers', () => {
    const longSource = Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const d: Diagnostic = {
      severity: 'error',
      source: 'validator',
      line: 12,
      column: 0,
      message: 'issue',
    };
    const out = formatDiagnostic(d, longSource);
    expect(out).toContain('12 |');
  });
});

describe('formatDiagnostics — multi-diagnostic report', () => {
  it('stacks blocks with a summary', () => {
    const ds: Diagnostic[] = [
      {
        severity: 'error',
        source: 'validator',
        line: 2,
        column: 4,
        endColumn: 7,
        message: 'first problem',
      },
      {
        severity: 'warning',
        source: 'validator',
        line: 4,
        column: 12,
        endColumn: 20,
        message: 'second problem',
      },
    ];
    const out = formatDiagnostics(ds, SOURCE, { filename: 'demo.xml' });
    expect(out).toContain('first problem');
    expect(out).toContain('second problem');
    expect(out).toContain('aborted: 1 error, 1 warning');
  });

  it('returns empty string on empty input', () => {
    expect(formatDiagnostics([], SOURCE)).toBe('');
  });
});

describe('formatDiagnostic — over-long lines are windowed', () => {
  it('shows a 160-char window around the carets, marking cut edges', () => {
    const line = `<a>${'x'.repeat(5000)}<bad attr="v"/>${'y'.repeat(5000)}</a>`;
    const column = line.indexOf('<bad');
    const d: Diagnostic = {
      severity: 'error',
      source: 'validator',
      line: 1,
      column,
      endLine: 1,
      endColumn: column + 16,
      message: 'that element is bad',
    };
    const out = formatDiagnostic(d, line, { filename: 'demo.xml' });
    const rows = out.split('\n');
    const excerpt = rows.find((r) => r.includes('<bad'));
    expect(excerpt).toBeDefined();
    // Both edges were cut, so both carry the ellipsis marker.
    expect(excerpt).toContain('…');
    expect(excerpt?.length).toBeLessThan(200);
    // The carets sit under the offending element inside the window.
    const caretRow = rows.find((r) => r.includes('^'));
    expect(caretRow).toBeDefined();
    expect(caretRow?.indexOf('^')).toBeGreaterThan(0);
    expect(caretRow?.length).toBeLessThan(200);
  });

  it('leaves a line at the window width untouched', () => {
    const line = `<gen type="text" value="${'v'.repeat(100)}"/>`;
    const d: Diagnostic = {
      severity: 'error',
      source: 'validator',
      line: 1,
      column: 0,
      message: 'whatever',
    };
    const out = formatDiagnostic(d, line, { filename: 'demo.xml' });
    expect(out).toContain(line);
    expect(out).not.toContain('…');
  });
});
