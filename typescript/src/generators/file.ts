/**
 * File generator.
 *
 * `<gen type="file" src="./path/to/list.txt"/>` in the DSL: load a list
 * of string values from a file (one per line, empty lines skipped) and
 * pick uniformly from them for each cell.
 *
 * `<gen type="file" src="./path/to/users.csv" column="email"/>` switches
 * into CSV-column mode. The first row is treated as a header for named
 * columns. Numeric columns are 1-based and may skip a header row with
 * `header="true"`.
 *
 * The loader is kept separate from the generator so that:
 *   - the module stays testable without touching the filesystem
 *     (inject an in-memory loader in unit tests);
 *   - the same loader can be shared across multiple generators that
 *     reference the same file path (caching happens at a higher layer);
 *   - alternate sources (e.g. HTTP, npm-packaged locale data) can be
 *     plugged in without changing generator code.
 *
 * See docs/vision/10-generators.md for the strategy around user-supplied
 * data files and future expansion to per-locale npm packs.
 */

import { readFileSync } from 'node:fs';

import { randomPick } from '../prng/random.js';

import type { Generator } from './generator.js';

export interface FileSourceOptions {
  readonly column?: string | undefined;
  readonly header?: string | boolean | undefined;
  readonly delimiter?: string | undefined;
}

export type FileValueLoader = (path: string, options: FileSourceOptions) => string[];
export type LegacyListLoader = (path: string) => string[];

export interface CsvColumnSource {
  readonly rows: readonly (readonly string[])[];
  /** The header row as read, kept so a SECOND column can still be resolved by name. */
  readonly headerRow: readonly string[];
  readonly column: string;
  readonly columnIndex: number;
  readonly delimiter: string;
  readonly skipHeader: boolean;
}

/**
 * Read a list file from disk and return its trimmed non-empty lines.
 * Used as the default loader by `fileUniform` but exported for reuse.
 */
export function loadListFile(path: string): string[] {
  const content = readFileSync(path, 'utf8');
  const lines: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) lines.push(trimmed);
  }
  return lines;
}

export function loadFileValues(path: string, options: FileSourceOptions = {}): string[] {
  const normalized = normalizeFileSourceOptions(options);
  if (!normalized.column) return loadListFile(path);
  return loadCsvColumnFile(path, normalized);
}

export function loadCsvColumnFile(path: string, options: FileSourceOptions): string[] {
  const source = loadCsvColumnSource(path, options);
  const values = source.rows
    .map((row) => csvColumnCell(row, source.columnIndex))
    .filter((cell) => cell.length > 0);

  if (values.length === 0) {
    throw new Error(`file generator: CSV column "${source.column}" at "${path}" has no values`);
  }
  return values;
}

export function loadCsvColumnSource(path: string, options: FileSourceOptions): CsvColumnSource {
  const normalized = normalizeFileSourceOptions(options);
  const column = normalized.column;
  if (!column) throw new Error('file generator: CSV column must be provided');

  const content = readFileSync(path, 'utf8');
  const rows = parseCsvRows(content, normalized.delimiter).filter((row) =>
    row.some((cell) => cell.trim().length > 0),
  );
  if (rows.length === 0) {
    throw new Error(`file generator: CSV file at "${path}" is empty`);
  }

  const columnIndex = resolveCsvColumnIndex(rows[0] ?? [], column);
  const skipHeader = shouldSkipHeader(column, normalized.header);
  return {
    rows: skipHeader ? rows.slice(1) : rows,
    headerRow: rows[0] ?? [],
    column,
    columnIndex,
    delimiter: normalized.delimiter,
    skipHeader,
  };
}

export function parseCsvRows(content: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
    quotedField = false;
  };

  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0 && !quotedField) {
      inQuotes = true;
      quotedField = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      continue;
    }
    if (ch === '\n') {
      pushRow();
      continue;
    }
    if (ch === '\r') {
      if (content[i + 1] === '\n') i += 1;
      pushRow();
      continue;
    }
    field += ch;
  }

  if (inQuotes) throw new Error('file generator: unterminated quoted CSV field');
  if (field.length > 0 || row.length > 0 || !content.endsWith('\n')) pushRow();
  return rows;
}

/**
 * Build a Generator that reads a list file and picks uniformly from its
 * lines for each cell. The file is loaded eagerly at generator-build
 * time (so the cost is amortised across all `count` picks).
 *
 * An explicit loader may be supplied in place of `loadListFile` for
 * testing or to plug in alternate sources.
 */
export function fileUniform(
  path: string,
  optionsOrLoader: FileSourceOptions | LegacyListLoader = {},
  loader: FileValueLoader = loadFileValues,
): Generator {
  const options = typeof optionsOrLoader === 'function' ? {} : optionsOrLoader;
  const values =
    typeof optionsOrLoader === 'function' ? optionsOrLoader(path) : loader(path, options);
  if (values.length === 0) {
    throw new Error(`file generator: list at "${path}" is empty`);
  }
  return (count, prng) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      out[i] = randomPick(prng, values);
    }
    return out;
  };
}

interface NormalizedFileSourceOptions {
  readonly column?: string | undefined;
  readonly header: boolean;
  readonly delimiter: string;
}

function normalizeFileSourceOptions(options: FileSourceOptions): NormalizedFileSourceOptions {
  const column = normalizeOptionalText(options.column);
  if (options.column !== undefined && column === undefined) {
    throw new Error('file generator: column must not be empty');
  }
  return {
    column,
    header: parseHeaderFlag(options.header),
    delimiter: parseDelimiter(options.delimiter),
  };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseHeaderFlag(value: string | boolean | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error('file generator: header must be true or false');
}

export function parseDelimiter(value: string | undefined): string {
  if (value === undefined) return ',';
  // A single character is taken verbatim, including a real tab. This keeps
  // normalization idempotent: `normalizeFileSourceOptions` runs at every public
  // entry point, so already-resolved options may pass through it again. Without
  // this, a resolved tab ("\t") would be trimmed away to "" on the second pass
  // and silently fall back to a comma, breaking tab/`\t` delimiters.
  if (value.length === 1) return value;
  const normalized = value.trim();
  if (!normalized) return ',';
  const aliases: Record<string, string> = {
    comma: ',',
    semicolon: ';',
    tab: '\t',
    '\\t': '\t',
    pipe: '|',
  };
  const delimiter = aliases[normalized.toLowerCase()] ?? normalized;
  if (delimiter.length !== 1) {
    throw new Error('file generator: delimiter must be one character');
  }
  return delimiter;
}

export function resolveCsvColumnIndex(headerRow: readonly string[], column: string): number {
  if (/^[1-9][0-9]*$/.test(column)) return Number(column) - 1;

  // `trim()` here is load-bearing beyond stray spaces: it also strips the UTF-8
  // BOM that Excel writes ahead of the first header cell, because ECMAScript
  // counts U+FEFF as whitespace. Without it every "Save as CSV" export from
  // Excel would fail to resolve its FIRST column by name and no other. Keep
  // trim(), or strip U+FEFF explicitly if this is ever narrowed.
  const idx = headerRow.findIndex((cell) => cell.trim() === column);
  if (idx < 0) {
    throw new Error(`file generator: CSV column "${column}" was not found in the header row`);
  }
  return idx;
}

function shouldSkipHeader(column: string, header: boolean): boolean {
  return header || !/^[1-9][0-9]*$/.test(column);
}

export function csvColumnCell(row: readonly string[], columnIndex: number): string {
  return (row[columnIndex] ?? '').trim();
}
