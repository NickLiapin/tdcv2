/**
 * Extracting the typed output columns from a `<block>`: a `<data>` with a `name`
 * is a column, one without is decorative text.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §1.
 */

import { describe, expect, it } from 'vitest';

import { extractDeclaredColumns } from '../../src/output/columns.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/validate.js';
import { parseStrict } from '../../src/parser/index.js';

const doc = (blockBody: string) =>
  parseStrict(
    `<tdc><env count="2" seed="s"><sequence name="A"><gen type="number" value="1..9"/></sequence></env>` +
      `<block>${blockBody}</block></tdc>`,
  );

describe('extractDeclaredColumns', () => {
  it('treats a named <data> as a column and keeps its declared type', () => {
    const cols = extractDeclaredColumns(
      doc('<line><data name="Id" type="int64">${{A}}</data></line>'),
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]?.name).toBe('Id');
    expect(cols[0]?.template).toBe('${{A}}');
    expect(cols[0]?.type).toEqual({ kind: 'int64', nullable: false });
  });

  it('ignores a <data> without a name (decorative text)', () => {
    const cols = extractDeclaredColumns(
      doc('<line><data>just text ${{A}}</data><data name="Id" type="int64">${{A}}</data></line>'),
    );
    expect(cols.map((c) => c.name)).toEqual(['Id']);
  });

  it('leaves type undefined when the attribute is absent', () => {
    const cols = extractDeclaredColumns(doc('<line><data name="City">${{A}}</data></line>'));
    expect(cols[0]?.type).toBeUndefined();
  });

  it('collects columns across several lines in document order', () => {
    const cols = extractDeclaredColumns(
      doc(
        '<line><data name="A1" type="int64">${{A}}</data></line>' +
          '<line><data name="B2" type="string">${{A}}</data>' +
          '<data name="C3" type="bool">${{A}}</data></line>',
      ),
    );
    expect(cols.map((c) => c.name)).toEqual(['A1', 'B2', 'C3']);
  });

  it('keeps a composite template as the column body', () => {
    const cols = extractDeclaredColumns(
      doc('<line><data name="Label" type="string">id=${{A}} !</data></line>'),
    );
    expect(cols[0]?.template).toBe('id=${{A}} !');
  });

  it('parses nullable and decimal types', () => {
    const cols = extractDeclaredColumns(
      doc('<line><data name="M" type="decimal(18,2)|null">${{A}}</data></line>'),
    );
    expect(cols[0]?.type).toEqual({ kind: 'decimal', nullable: true, precision: 18, scale: 2 });
  });

  it('rejects duplicate column names', () => {
    expect(() =>
      extractDeclaredColumns(
        doc(
          '<line><data name="X" type="int64">${{A}}</data>' +
            '<data name="X" type="int64">${{A}}</data></line>',
        ),
      ),
    ).toThrow(/duplicate column name "X"/);
  });

  it('reports a bad type with the column name', () => {
    expect(() =>
      extractDeclaredColumns(doc('<line><data name="Bad" type="nope">${{A}}</data></line>')),
    ).toThrow(/column "Bad".*unknown column type "nope"/);
  });

  it('returns no columns for a plain text block', () => {
    expect(extractDeclaredColumns(doc('<line><data>${{A}}</data></line>'))).toEqual([]);
  });
});

describe('validator catches a bad type at load time (TDC194)', () => {
  const diags = (dataTag: string) =>
    validate(
      parse(
        `<tdc><env count="2" seed="s"><sequence name="A"><gen type="number" value="1..9"/></sequence></env>` +
          `<block><line>${dataTag}</line></block></tdc>`,
      ).tree,
    ).diagnostics;

  it('rejects an unknown type', () => {
    const d = diags('<data name="x" type="nope">${{A}}</data>');
    expect(d.find((x) => x.code === 'TDC194')?.severity).toBe('error');
  });

  it('rejects a malformed decimal', () => {
    expect(
      diags('<data name="x" type="decimal(99,2)">${{A}}</data>').find((x) => x.code === 'TDC194'),
    ).toBeDefined();
  });

  it('errors when type= has no name — the typed column would never appear', () => {
    const d = diags('<data type="int64">${{A}}</data>').find((x) => x.code === 'TDC194');
    expect(d?.severity).toBe('error');
  });

  it('accepts a well-formed typed column', () => {
    expect(
      diags('<data name="x" type="decimal(18,2)|null">${{A}}</data>').find(
        (x) => x.code === 'TDC194',
      ),
    ).toBeUndefined();
  });
});
