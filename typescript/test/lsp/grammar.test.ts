import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const grammarPath = fileURLToPath(new URL('../../../editor/tdc.tmLanguage.json', import.meta.url));

interface Grammar {
  scopeName: string;
  fileTypes: string[];
  patterns: unknown[];
  repository: Record<string, unknown>;
}

function loadGrammar(): Grammar {
  return JSON.parse(readFileSync(grammarPath, 'utf8')) as Grammar;
}

describe('TextMate grammar (editor/tdc.tmLanguage.json)', () => {
  it('is valid JSON with the expected top-level shape', () => {
    const g = loadGrammar();
    expect(g.scopeName).toBe('source.tdc');
    expect(g.fileTypes).toContain('tdc');
    expect(Array.isArray(g.patterns)).toBe(true);
    for (const key of ['comment', 'interpolation', 'string', 'attribute', 'data-block', 'tag']) {
      expect(g.repository[key]).toBeDefined();
    }
  });

  it('every begin/end/match regex compiles', () => {
    const regexes: string[] = [];
    const collect = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if ((key === 'begin' || key === 'end' || key === 'match') && typeof value === 'string') {
          regexes.push(value);
        } else {
          collect(value);
        }
      }
    };
    collect(loadGrammar());
    expect(regexes.length).toBeGreaterThan(0);
    // Oniguruma is a superset of JS regex for these simple patterns, so a
    // JS compile is a solid smoke test against typos / bad escapes.
    for (const r of regexes) expect(() => new RegExp(r)).not.toThrow();
  });
});
