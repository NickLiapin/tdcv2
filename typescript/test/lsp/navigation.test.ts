import { describe, expect, it } from 'vitest';

import {
  computeDefinition,
  computeHover,
  computeReferences,
  computeRename,
} from '../../src/lsp/navigation.js';
import type { Position, Range } from '../../src/lsp/types.js';

/** Split a source with a `|` caret marker into text + position. */
function locate(srcWithCaret: string): { text: string; position: Position } {
  const idx = srcWithCaret.indexOf('|');
  const text = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = srcWithCaret.slice(0, idx);
  return {
    text,
    position: {
      line: (before.match(/\n/g) ?? []).length,
      character: before.length - (before.lastIndexOf('\n') + 1),
    },
  };
}

function offsetAt(text: string, p: Position): number {
  const lines = text.split('\n');
  let off = 0;
  for (let i = 0; i < p.line; i++) off += (lines[i] ?? '').length + 1;
  return off + p.character;
}

function sliceRange(text: string, range: Range): string {
  return text.slice(offsetAt(text, range.start), offsetAt(text, range.end));
}

function applyEdits(text: string, edits: { range: Range; newText: string }[]): string {
  const byPos = [...edits].sort(
    (a, b) => offsetAt(text, b.range.start) - offsetAt(text, a.range.start),
  );
  let out = text;
  for (const e of byPos) {
    out =
      out.slice(0, offsetAt(text, e.range.start)) +
      e.newText +
      out.slice(offsetAt(text, e.range.end));
  }
  return out;
}

const DOC = [
  '<sequence name="Gender"><gen type="text" value="M,F"/></sequence>',
  '<sequence name="Age" parent="Gender.M"><gen type="number" value="1..9"/></sequence>',
  '<data>${{Gender}} ${{Age}}</data>',
].join('\n');

describe('computeHover', () => {
  it('describes a tag', () => {
    const { text, position } = locate('<g|en type="text" value="A"/>');
    expect(computeHover(text, position)?.contents).toContain('value generator');
  });

  it('describes an attribute', () => {
    const { text, position } = locate('<env co|unt="3"/>');
    expect(computeHover(text, position)?.contents).toContain('How many records to generate');
  });

  it('describes a ${{…}} sequence reference and whether it is declared', () => {
    const src =
      '<sequence name="Gender"><gen type="text" value="M"/></sequence>\n<data>${{Gen|der}}</data>';
    const { text, position } = locate(src);
    const hover = computeHover(text, position);
    expect(hover?.contents).toContain('Gender');
    expect(hover?.contents).toContain('declared in this file');
  });

  it('returns null for an unknown token', () => {
    const { text, position } = locate('<data>just t|ext</data>');
    expect(computeHover(text, position)).toBeNull();
  });
});

describe('computeDefinition', () => {
  it('jumps from a parent= reference to the sequence declaration', () => {
    const { text, position } = locate(
      '<sequence name="Gender"><gen type="text" value="M"/></sequence>\n<sequence name="Age" parent="Gen|der.M"><gen type="number" value="1..9"/></sequence>',
    );
    const def = computeDefinition(text, position);
    expect(def).not.toBeNull();
    expect(def?.start.line).toBe(0);
    expect(sliceRange(text, def!)).toBe('Gender');
  });

  it('jumps from a ${{…}} reference to its declaration', () => {
    const { text, position } = locate(DOC.replace('${{Age}}', '${{A|ge}}'));
    const def = computeDefinition(text, position);
    expect(sliceRange(text, def!)).toBe('Age');
    expect(def?.start.line).toBe(1);
  });

  it('returns null when the caret is on a tag', () => {
    const { text, position } = locate('<g|en type="text" value="A"/>');
    expect(computeDefinition(text, position)).toBeNull();
  });
});

describe('computeReferences', () => {
  it('finds the declaration, the parent=, and the ${{…}} use', () => {
    const { text, position } = locate(DOC.replace('${{Gender}}', '${{Gen|der}}'));
    const refs = computeReferences(text, position);
    expect(refs).toHaveLength(3); // decl + parent + interpolation
    for (const r of refs) expect(sliceRange(text, r)).toBe('Gender');
  });
});

describe('computeRename', () => {
  it('renames a sequence everywhere it is referenced', () => {
    const { text, position } = locate(DOC.replace('name="Gender"', 'name="Gen|der"'));
    const edits = computeRename(text, position, 'Sex');
    expect(edits.length).toBe(3);
    const renamed = applyEdits(text, edits);
    expect(renamed).toContain('name="Sex"');
    expect(renamed).toContain('parent="Sex.M"'); // base renamed, ".M" value kept
    expect(renamed).toContain('${{Sex}}');
    expect(renamed).not.toContain('Gender');
  });
});
