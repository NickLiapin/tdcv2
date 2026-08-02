/**
 * The shared `<pool>` fixtures, run against the reference implementation.
 *
 * The cross-language fixtures exist so the four ports have a contract to hit,
 * and until now nothing in TypeScript read them — the reference was trusted to
 * be right by construction. For a brand-new construct that is not good enough:
 * these files are about to drive four ports, and a fixture that does not match
 * the implementation it was generated from would send all four somewhere wrong.
 *
 * So the reference checks itself against them too. If a later change to the
 * engine moves a value, this fails here first, in the language where the fix
 * belongs, instead of surfacing as four mysterious port failures.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, '..', '..', '..', 'fixtures', 'cross-language');

interface OutputCase {
  readonly name: string;
  readonly description: string;
  readonly config: string;
  readonly expected: readonly string[];
}

interface DiagnosticCase {
  readonly name: string;
  readonly demonstrates: string;
  readonly description: string;
  readonly config: string;
  readonly expected: readonly string[];
}

function loadOutput(file: string): readonly OutputCase[] {
  const raw = readFileSync(resolve(shared, 'cases', file), 'utf8');
  return (JSON.parse(raw) as { cases: readonly OutputCase[] }).cases;
}

function loadDiagnostics(file: string): readonly DiagnosticCase[] {
  const raw = readFileSync(resolve(shared, 'diagnostics', file), 'utf8');
  return (JSON.parse(raw) as { cases: readonly DiagnosticCase[] }).cases;
}

describe('shared pool fixtures — output', () => {
  for (const c of loadOutput('pool.json')) {
    it(`${c.name} renders the expected rows`, () => {
      const parsed = parse(c.config);
      expect(parsed.diagnostics).toEqual([]);
      const rows = render(parsed.tree).split('\n').filter(Boolean);
      expect(rows).toEqual([...c.expected]);
    });
  }
});

describe('shared pool fixtures — diagnostics', () => {
  for (const c of loadDiagnostics('pool.json')) {
    it(`${c.name} reports ${c.demonstrates}`, () => {
      // The code and the position are the contract; the wording is not. Columns
      // are the API's own 0-based ones, which is what every port harness reads —
      // the CLI adds one when it prints, and recording the printed number here
      // would have put this file one column away from the four that matter.
      const parsed = parse(c.config);
      expect(parsed.diagnostics).toEqual([]);
      const reported = validate(parsed.tree).diagnostics.map(
        (d) => `${d.severity} ${d.code ?? '?'} ${String(d.line)}:${String(d.column)}`,
      );
      expect(reported).toEqual([...c.expected]);
    });
  }
});
