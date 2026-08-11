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
import {
  decimalsFromAttrs,
  parseInterp,
  parseMode,
  spreadFromAttrs,
} from '../generators/pattern.js';
import { extractAttrs } from '../processor/walk.js';
import { checkGenPattern } from './pattern.js';
import { checkSequentialDropsPercent } from './text.js';

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
  checkSequentialDropsPercent(gen, ctx.diagnostics);
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

/** The three ways a `<gen type="pattern">` can be given a shape to read. */
const DRAWING_SOURCES = ['points', 'src', 'upper'] as const;

/**
 * A drawing's `src=` — the same existence check, without the file generator's
 * own rules about columns and linked rows.
 *
 * Checked before the run rather than during it: a missing picture discovered on
 * row one of a million-row job has already cost whatever the job cost. `src=` is
 * one of three ways to hand the generator a shape, so its absence is only a
 * mistake when the other two are absent too — which is TDC244, the drawing
 * equivalent of a `type="regex"` with no pattern.
 */
export function checkGenDrawing(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: FileValidationContext,
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  checkGenPattern(gen, ctx.diagnostics);
  if (DRAWING_SOURCES.every((name) => (attrMap[name] ?? '').trim() === '')) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="pattern"> has nothing to draw from',
      hint: 'Give it a shape: points="0,0 1,5 2,3", src="curve.svg" (or a PNG), or upper="…" with an optional lower="…" for a band.',
      code: 'TDC244',
    });
    return;
  }

  checkDrawingValues(attrs, attrMap, ctx.diagnostics);

  const srcAttr = findAttr(attrs, 'src');
  const path = attrMap['src'] ?? '';
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

/**
 * `mode=`, `interp=`, `spread=` and `decimals=` — the four drawing attributes whose
 * value is a fixed word or a number.
 *
 * They were read only by the generator, so `check` called `mode="banana"` valid and
 * the run then refused it with a bare sentence and no code: `check` answers "would
 * this run?" everywhere else, and here it answered wrongly for a config a reader
 * would fix in a second.
 *
 * The validator calls the GENERATOR's own parsers rather than repeating their rules.
 * A second copy of "linear, smooth or step" is a second thing to keep in step, and the
 * failure that produces — `check` accepting what the run refuses — is exactly the one
 * being closed here.
 */
function checkDrawingValues(
  attrs: readonly AttrContext[],
  attrMap: Record<string, string>,
  diagnostics: Diagnostic[],
): void {
  const checks: readonly [string, () => unknown][] = [
    ['mode', () => parseMode(attrMap['mode'])],
    ['interp', () => parseInterp(attrMap['interp'])],
    ['spread', () => spreadFromAttrs(attrMap)],
    ['decimals', () => decimalsFromAttrs(attrMap)],
  ];
  for (const [name, run] of checks) {
    const attr = findAttr(attrs, name);
    if (!attr) continue;
    try {
      run();
    } catch (err) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(attr),
        message: err instanceof Error ? err.message : String(err),
        hint: 'Every drawing attribute is checked before the run, so `check` and the run agree.',
        code: 'TDC285',
      });
    }
  }
}
