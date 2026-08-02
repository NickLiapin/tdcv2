import { describe, expect, it } from 'vitest';

import { parsePackFile } from '../../src/data-pack/parse.js';

describe('parsePackFile', () => {
  it('parses a bare list with no header', () => {
    const r = parsePackFile('Rodrigo\nFernando\nDiego\n');
    expect(r.hasHeader).toBe(false);
    expect(r.header).toEqual({});
    expect(r.values).toEqual(['Rodrigo', 'Fernando', 'Diego']);
    expect(r.bodyStartLine).toBe(1);
  });

  it('trims values and drops blank lines', () => {
    const r = parsePackFile('  A  \n\n\tB\n   \nC\n');
    expect(r.values).toEqual(['A', 'B', 'C']);
  });

  it('parses a fenced header and body', () => {
    const src = [
      '---',
      'description: Spanish male names',
      'address: es.person.male.firstName',
      'locale: es',
      '---',
      'Rodrigo',
      'Fernando',
    ].join('\n');
    const r = parsePackFile(src);
    expect(r.hasHeader).toBe(true);
    expect(r.header).toEqual({
      description: 'Spanish male names',
      address: 'es.person.male.firstName',
      locale: 'es',
    });
    expect(r.values).toEqual(['Rodrigo', 'Fernando']);
  });

  it('lowercases header keys and ignores comments/blank lines in header', () => {
    const src = ['---', '# a comment', 'Address: X', '', 'LOCALE: ru', '---', 'v'].join('\n');
    const r = parsePackFile(src);
    expect(r.header).toEqual({ address: 'X', locale: 'ru' });
  });

  it('tolerates leading blank lines before the fence', () => {
    const src = ['', '', '---', 'address: X', '---', 'v'].join('\n');
    const r = parsePackFile(src);
    expect(r.hasHeader).toBe(true);
    expect(r.header['address']).toBe('X');
    expect(r.values).toEqual(['v']);
  });

  it('an unclosed header yields empty body', () => {
    const src = ['---', 'address: X', 'Rodrigo', 'Fernando'].join('\n');
    const r = parsePackFile(src);
    expect(r.hasHeader).toBe(true);
    expect(r.values).toEqual([]);
  });

  it('does not treat a non-leading --- as a header', () => {
    const r = parsePackFile('Rodrigo\n---\nFernando\n');
    expect(r.hasHeader).toBe(false);
    // The `---` line survives as a value (it is non-blank text here).
    expect(r.values).toEqual(['Rodrigo', '---', 'Fernando']);
  });
});
