/**
 * Navigation + hover brains: hover tooltips, go-to-definition, find-
 * references, and rename for sequence names.
 *
 * Pure and dependency-free, position-based. What's under the caret is
 * resolved by `tokenAt` via text scanning (no parse — robust on half-typed
 * documents), then each feature acts on that token:
 *   - hover      → a short doc for the tag / attribute / sequence reference
 *   - definition → the `<sequence name="X">` declaration for a reference
 *   - references → every place that names sequence X (decl + parent + ${{}})
 *   - rename     → replace exactly the base-name span at each of those places
 */

import { ATTR_DOCS, TAG_DOCS } from './docs.js';
import type { Position, Range } from './types.js';

export type Token =
  | { readonly kind: 'tag'; readonly name: string; readonly range: Range }
  | { readonly kind: 'attr'; readonly name: string; readonly range: Range }
  | { readonly kind: 'ref'; readonly name: string; readonly base: string; readonly range: Range };

export interface Hover {
  readonly contents: string;
  readonly range: Range;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

// --- position ⇄ offset -----------------------------------------------------

function offsetAt(text: string, position: Position): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += (lines[i] ?? '').length + 1; // +1 for the '\n'
  }
  return offset + position.character;
}

function positionAt(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, clamped);
  return {
    line: (before.match(/\n/g) ?? []).length,
    character: clamped - (before.lastIndexOf('\n') + 1),
  };
}

function rangeAt(text: string, start: number, end: number): Range {
  return { start: positionAt(text, start), end: positionAt(text, end) };
}

// --- what's under the caret ------------------------------------------------

function refToken(text: string, full: string, start: number, end: number): Token {
  return {
    kind: 'ref',
    name: full,
    base: full.split('.')[0] ?? full,
    range: rangeAt(text, start, end),
  };
}

export function tokenAt(text: string, position: Position): Token | null {
  const off = offsetAt(text, position);

  // 1. ${{ Name(.field) }} interpolation reference.
  for (const m of text.matchAll(/\$\{\{\s*([\w.]+)\s*\}\}/g)) {
    const name = m[1];
    if (name === undefined) continue;
    const start = m.index + m[0].indexOf(name);
    if (off >= start && off <= start + name.length)
      return refToken(text, name, start, start + name.length);
  }

  // 2. parent="Name(.value)" and 3. <sequence … name="Name"> — the VALUE is a
  //    sequence reference (parent target / the declaration naming itself).
  for (const re of [/\bparent\s*=\s*"([^"]+)"/g, /<sequence\b[^>]*?\bname\s*=\s*"([^"]+)"/g]) {
    for (const m of text.matchAll(re)) {
      const val = m[1];
      if (val === undefined) continue;
      const start = m.index + m[0].indexOf(`"${val}"`) + 1;
      if (off >= start && off <= start + val.length)
        return refToken(text, val, start, start + val.length);
    }
  }

  // 4. Tag name.
  for (const m of text.matchAll(/<\/?([A-Za-z][\w-]*)/g)) {
    const name = m[1];
    if (name === undefined) continue;
    const start = m.index + m[0].indexOf(name);
    if (off >= start && off <= start + name.length) {
      return { kind: 'tag', name, range: rangeAt(text, start, start + name.length) };
    }
  }

  // 5. Attribute name.
  for (const m of text.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"/g)) {
    const name = m[1];
    if (name === undefined) continue;
    if (off >= m.index && off <= m.index + name.length) {
      return { kind: 'attr', name, range: rangeAt(text, m.index, m.index + name.length) };
    }
  }

  return null;
}

// --- declarations & references ---------------------------------------------

export function findSequenceDeclaration(text: string, name: string): Range | null {
  for (const m of text.matchAll(/<sequence\b[^>]*?\bname\s*=\s*"([^"]+)"/g)) {
    if (m[1] === name) {
      const start = m.index + m[0].indexOf(`"${name}"`) + 1;
      return rangeAt(text, start, start + name.length);
    }
  }
  return null;
}

/** Every span that names sequence `base` (declaration, parent=, `${{…}}`). */
export function findReferences(text: string, base: string): Range[] {
  const out: Range[] = [];
  const push = (start: number): void => {
    out.push(rangeAt(text, start, start + base.length));
  };
  for (const m of text.matchAll(/<sequence\b[^>]*?\bname\s*=\s*"([^"]+)"/g)) {
    if (m[1] === base) push(m.index + m[0].indexOf(`"${base}"`) + 1);
  }
  for (const m of text.matchAll(/\bparent\s*=\s*"([^"]+)"/g)) {
    const val = m[1];
    if (val !== undefined && (val === base || val.startsWith(`${base}.`))) {
      push(m.index + m[0].indexOf(`"${val}"`) + 1);
    }
  }
  for (const m of text.matchAll(/\$\{\{\s*([\w.]+)\s*\}\}/g)) {
    const full = m[1];
    if (full !== undefined && (full === base || full.startsWith(`${base}.`))) {
      push(m.index + m[0].indexOf(full));
    }
  }
  return out;
}

// --- features --------------------------------------------------------------

export function computeHover(text: string, position: Position): Hover | null {
  const token = tokenAt(text, position);
  if (!token) return null;
  if (token.kind === 'tag') {
    const doc = TAG_DOCS[token.name];
    return doc ? { contents: `**\`<${token.name}>\`** — ${doc}`, range: token.range } : null;
  }
  if (token.kind === 'attr') {
    const doc = ATTR_DOCS[token.name];
    return doc ? { contents: `**\`${token.name}\`** — ${doc}`, range: token.range } : null;
  }
  const where = findSequenceDeclaration(text, token.base)
    ? 'declared in this file'
    : 'not declared in this file';
  return { contents: `**\`${token.base}\`** — a sequence, ${where}.`, range: token.range };
}

export function computeDefinition(text: string, position: Position): Range | null {
  const token = tokenAt(text, position);
  return token?.kind === 'ref' ? findSequenceDeclaration(text, token.base) : null;
}

export function computeReferences(text: string, position: Position): Range[] {
  const token = tokenAt(text, position);
  return token?.kind === 'ref' ? findReferences(text, token.base) : [];
}

export function computeRename(text: string, position: Position, newName: string): TextEdit[] {
  const token = tokenAt(text, position);
  if (token?.kind !== 'ref') return [];
  return findReferences(text, token.base).map((range) => ({ range, newText: newName }));
}
