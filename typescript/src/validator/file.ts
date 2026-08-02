import {
  type DataSourceOptions,
  formatDataSourceAttempts,
  resolveExistingDataSourcePath,
} from '../data-source/index.js';
import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { loadFileValues } from '../generators/file.js';
import { extractAttrs } from '../processor/walk.js';

export interface FileValidationContext {
  readonly diagnostics: Diagnostic[];
  readonly dataSources: DataSourceOptions;
}

export function checkGenFile(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: FileValidationContext,
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const srcAttr = findAttr(attrs, 'src');
  if (!srcAttr) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="file"> requires a "src" attribute',
      hint: 'Provide the path to a UTF-8 text file with one value per line.',
      code: 'TDC060',
    });
  }

  // Checked whether or not there is a src=, because it is not about the file:
  // a row link needs a column with or without one. Stopping at the missing src
  // would hand back one complaint, then the next on the following run, which is
  // the treadmill this whole report format exists to avoid.
  const rowAttr = findAttr(attrs, 'row');
  const columnAttr = findAttr(attrs, 'column');
  if (rowAttr && !columnAttr) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(rowAttr),
      message: 'row-linked file generators require a CSV "column" attribute',
      hint: 'Use column="name" or column="2" together with row="sharedKey".',
      code: 'TDC064',
    });
  }

  if (!srcAttr) return;

  const path = attrMap['src'] ?? '';
  let resolved: string;
  try {
    resolved = resolveExistingDataSourcePath(path, ctx.dataSources).path;
  } catch (err) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(srcAttr),
      message: `cannot read file "${path}"`,
      hint:
        err instanceof Error && 'attempts' in err
          ? formatDataSourceAttempts((err as { attempts: readonly string[] }).attempts)
          : 'Paths are relative to the current data-source base directory.',
      code: 'TDC061',
    });
    return;
  }

  if (!columnAttr) return;

  try {
    loadFileValues(resolved, {
      column: attrMap['column'],
      header: attrMap['header'],
      delimiter: attrMap['delimiter'],
    });
  } catch (err) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(columnAttr),
      message: err instanceof Error ? err.message : String(err),
      hint: 'For CSV files, use a header name like column="email" or a 1-based index like column="2".',
      code: 'TDC062',
    });
  }
}

/**
 * A drawing's `src=` — the same existence check, without the file generator's
 * own rules about columns and linked rows.
 *
 * Checked before the run rather than during it: a missing picture discovered on
 * row one of a million-row job has already cost whatever the job cost. A pattern
 * with no `src=` is not an error here — it may be drawn with `points=` or
 * `upper=` instead, and the generator says so itself.
 */
export function checkGenDrawing(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: FileValidationContext,
): void {
  const attrs = gen.attr();
  const srcAttr = findAttr(attrs, 'src');
  const path = extractAttrs(attrs)['src'] ?? '';
  if (!srcAttr || path.trim() === '') return;

  try {
    resolveExistingDataSourcePath(path, ctx.dataSources);
  } catch (err) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(srcAttr),
      message: `cannot read file "${path}"`,
      hint:
        err instanceof Error && 'attempts' in err
          ? formatDataSourceAttempts((err as { attempts: readonly string[] }).attempts)
          : 'Paths are relative to the current data-source base directory.',
      code: 'TDC061',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}
