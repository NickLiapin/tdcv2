import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  fileUniform,
  loadCsvColumnFile,
  loadFileValues,
  loadListFile,
  parseCsvRows,
} from '../../src/generators/file.js';
import { createPrng } from '../../src/prng/prng.js';

// Build an isolated tmp directory per test file so concurrent runs don't
// collide. The directory is intentionally NOT deleted afterward; OS
// cleanup takes care of the tmp root, and leaving it around helps
// investigate failures.
const tmpRoot = mkdtempSync(join(tmpdir(), 'tdc-test-file-'));

function writeTmp(name: string, content: string): string {
  const p = join(tmpRoot, name);
  writeFileSync(p, content);
  return p;
}

afterAll(() => {
  // intentional no-op; see note above
});

describe('loadListFile', () => {
  it('reads each non-empty trimmed line from a file', () => {
    const path = writeTmp('simple.txt', 'alpha\nbeta\ngamma\n');
    expect(loadListFile(path)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('skips empty lines and trims whitespace', () => {
    const path = writeTmp('padded.txt', '  alpha\n\n  beta  \n\t\ngamma\n\n');
    expect(loadListFile(path)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('handles CRLF line endings', () => {
    const path = writeTmp('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    expect(loadListFile(path)).toEqual(['one', 'two', 'three']);
  });

  it('reads an existing bundled pack list file without error', () => {
    const path = join(
      __dirname,
      '..',
      '..',
      '..',
      'data',
      'packs',
      'ru',
      'person',
      'male',
      'firstName.txt',
    );
    const names = loadListFile(path);
    expect(names.length).toBeGreaterThan(0);
  });
});

describe('parseCsvRows', () => {
  it('parses quoted fields, escaped quotes, and commas inside values', () => {
    expect(parseCsvRows('name,email\n"Alice, A.","a@example.test"\n"Bob ""B""","b@test"')).toEqual([
      ['name', 'email'],
      ['Alice, A.', 'a@example.test'],
      ['Bob "B"', 'b@test'],
    ]);
  });

  it('throws on unterminated quoted fields', () => {
    expect(() => parseCsvRows('name,email\n"Alice,a@example.test')).toThrow(/unterminated/);
  });
});

describe('loadCsvColumnFile', () => {
  it('loads a named CSV column using the header row', () => {
    const path = writeTmp('users.csv', 'first,email\nAlice,a@example.test\nBob,b@example.test\n');
    expect(loadCsvColumnFile(path, { column: 'email' })).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('loads a 1-based numeric CSV column and can skip the header row', () => {
    const path = writeTmp('numeric.csv', 'first,email\nAlice,a@example.test\nBob,b@example.test\n');
    expect(loadCsvColumnFile(path, { column: '2', header: true })).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('supports semicolon-delimited files', () => {
    const path = writeTmp(
      'semicolon.csv',
      'first;email\nAlice;a@example.test\nBob;b@example.test\n',
    );
    expect(loadCsvColumnFile(path, { column: 'email', delimiter: ';' })).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('throws a clear error when a named column is missing', () => {
    const path = writeTmp('missing-column.csv', 'first,email\nAlice,a@example.test\n');
    expect(() => loadCsvColumnFile(path, { column: 'phone' })).toThrow(/was not found/);
  });

  it('throws a clear error when the CSV column option is empty', () => {
    const path = writeTmp('empty-column.csv', 'first,email\nAlice,a@example.test\n');
    expect(() => loadCsvColumnFile(path, { column: ' ' })).toThrow(/must not be empty/);
  });
});

describe('loadFileValues — tab-separated (TSV) columns', () => {
  // Regression: `loadFileValues` normalizes options once and then hands the
  // already-normalized options down to `loadCsvColumnSource`, which normalizes
  // a second time. A real tab delimiter must survive that round trip — earlier
  // it was trimmed away on the second pass and silently replaced by a comma,
  // so tab/`\t` delimiters were unusable end-to-end.
  const tsv = (rows: readonly (readonly string[])[]): string =>
    rows.map((cols) => cols.join('\t')).join('\n') + '\n';

  it('reads a tab-separated column via the "tab" delimiter alias', () => {
    const path = writeTmp(
      'tabbed.tsv',
      tsv([
        ['first_name', 'last_name', 'email'],
        ['Anna', 'Orlova', 'a@example.test'],
        ['Boris', 'Petrov', 'b@example.test'],
      ]),
    );
    expect(loadFileValues(path, { column: 'email', delimiter: 'tab' })).toEqual([
      'a@example.test',
      'b@example.test',
    ]);
  });

  it('reads a tab-separated column via the "\\t" delimiter alias', () => {
    const path = writeTmp(
      'tabbed-escape.tsv',
      tsv([
        ['first_name', 'last_name', 'email'],
        ['Anna', 'Orlova', 'a@example.test'],
      ]),
    );
    expect(loadFileValues(path, { column: 'email', delimiter: '\\t' })).toEqual(['a@example.test']);
  });

  it('reads a tab-separated column via a literal tab delimiter', () => {
    const path = writeTmp(
      'tabbed-literal.tsv',
      tsv([
        ['first_name', 'email'],
        ['Anna', 'a@example.test'],
      ]),
    );
    expect(loadFileValues(path, { column: 'email', delimiter: '\t' })).toEqual(['a@example.test']);
  });
});

describe('fileUniform generator', () => {
  it('produces exactly `count` cells drawn from file contents', () => {
    const path = writeTmp('names.txt', 'Alice\nBob\nCarol\nDave\n');
    const gen = fileUniform(path);
    const out = gen(10, createPrng('names'));
    expect(out).toHaveLength(10);
    for (const v of out) {
      expect(['Alice', 'Bob', 'Carol', 'Dave']).toContain(v);
    }
  });

  it('is deterministic across invocations with the same seed', () => {
    const path = writeTmp('det.txt', 'a\nb\nc\nd\n');
    const a = fileUniform(path)(10, createPrng('seed'));
    const b = fileUniform(path)(10, createPrng('seed'));
    expect(a).toEqual(b);
  });

  it('supports an injected loader (for tests without disk I/O)', () => {
    const stubLoader = (_path: string): string[] => ['red', 'green', 'blue'];
    const gen = fileUniform('unused', stubLoader);
    const out = gen(20, createPrng('colors'));
    expect(out).toHaveLength(20);
    for (const v of out) {
      expect(['red', 'green', 'blue']).toContain(v);
    }
  });

  it('throws a clear error if the file is empty', () => {
    const path = writeTmp('empty.txt', '\n  \n\t\n');
    expect(() => fileUniform(path)).toThrow(/empty/);
  });

  it('can draw values from a CSV column', () => {
    const path = writeTmp(
      'draw-email.csv',
      'first,email\nAlice,a@example.test\nBob,b@example.test\n',
    );
    const out = fileUniform(path, { column: 'email' })(8, createPrng('emails'));
    expect(out).toHaveLength(8);
    for (const v of out) {
      expect(['a@example.test', 'b@example.test']).toContain(v);
    }
  });

  // Excel writes a UTF-8 BOM ahead of the first cell on "Save as CSV", so the
  // header reads "\uFEFFsku" rather than "sku". Resolution survives it only
  // because trim() drops U+FEFF; pin that, since the failure would hit the
  // first column of every Excel export and nothing else.
  it('resolves the first column by name despite an Excel BOM', () => {
    const path = writeTmp('bom.csv', '\uFEFFsku,price\nA-1,540\nB-2,320\n');

    expect(parseCsvRows('\uFEFFsku,price\nA-1,540\n', ',')[0]?.[0]).toBe('\uFEFFsku');

    const out = fileUniform(path, { column: 'sku' })(4, createPrng('bom'));
    expect(out).toHaveLength(4);
    for (const v of out) expect(['A-1', 'B-2']).toContain(v);
  });

  it('drops the BOM from a value read without a header row', () => {
    const path = writeTmp('bom-values.csv', '\uFEFFA-1,540\nA-1,320\n');
    const out = fileUniform(path, { column: '1' })(4, createPrng('bom-values'));
    for (const v of out) expect(v).toBe('A-1');
  });
});
