/**
 * How a shared fixture is RUN — one definition, for the scripts and the suite alike.
 *
 * Three harnesses used to own a private copy of this: the cases script, the engines script and
 * the diagnostics script each spelled out how to turn a case into an answer. That was tolerable
 * while they were the only callers. They are not any more — the suite runs the same fixtures now
 * — and four copies of "render a case exactly as every implementation must" is four chances to
 * drift, on the one function whose whole job is that nothing drifts.
 *
 * Nothing here writes or verifies. The scripts still own `--update` and the reporting, because
 * writing `expected` is the reference's privilege and should stay in one obvious place.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPacks, packParameterNames, packParameterWidths } from '../src/data-pack/load.js';
import { TDC, type TdcOptions } from '../src/index.js';
import { parse } from '../src/parser/index.js';
import { validate } from '../src/validator/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const SHARED_DIR = resolve(here, '..', '..', 'fixtures', 'cross-language');
export const CASES_DIR = join(SHARED_DIR, 'cases');
export const DIAGNOSTICS_DIR = join(SHARED_DIR, 'diagnostics');

/** The engines the fixture covers. Engine 1 is already covered by the cases' own `expected`. */
export const ENGINES = [2, 3] as const satisfies readonly NonNullable<TdcOptions['engine']>[];

/** One case, as much of it as running the case needs. */
export interface FixtureCase {
  readonly name: string;
  readonly config: string;
  readonly expected?: readonly string[];
  readonly seed?: string;
  readonly count?: number;
  readonly locale?: string;
  readonly now?: string;
  readonly dataPath?: string;
}

export interface FixtureFile {
  readonly file: string;
  readonly doc: { readonly cases: readonly FixtureCase[] };
}

/** Every `*.json` in a fixture folder, sorted, as `{ file, doc }`. */
export function readFixtureFiles(dir: string): FixtureFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      doc: JSON.parse(readFileSync(join(dir, file), 'utf8')) as { cases: FixtureCase[] },
    }));
}

/**
 * Render one case exactly as every implementation must.
 *
 * `engine` is left out for the in-memory answer the case's own `expected` holds; the engines
 * fixture passes 2 and 3.
 */
/**
 * Render one case exactly as every implementation must.
 *
 * `engine` is left out for the in-memory answer the case's own `expected` holds; the engines
 * fixture passes 2 and 3.
 */
export function renderCase(testCase: FixtureCase, engine?: TdcOptions['engine']): string {
  return new TDC({
    configString: testCase.config,
    ...(engine === undefined ? {} : { engine }),
    ...(testCase.seed === undefined ? {} : { seed: testCase.seed }),
    ...(testCase.count === undefined ? {} : { count: testCase.count }),
    ...(testCase.locale === undefined ? {} : { locale: testCase.locale }),
    // A case that reads the clock has to pin it, or it passes today and fails tomorrow.
    ...(testCase.now === undefined ? {} : { now: Date.parse(testCase.now) }),
    // A case that reads a FILE names the folder its samples live in, relative to the cases
    // directory. Every implementation resolves it the same way.
    ...(testCase.dataPath === undefined ? {} : { dataPaths: [join(CASES_DIR, testCase.dataPath)] }),
  }).toString();
}

/**
 * Text to the `expected` array. The output always ends in a newline, so the final empty piece
 * of the split is dropped rather than stored as a blank line.
 */
export function toLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function fromLines(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

// The bundled packs, exactly as the CLI and every port's harness supply them. Without them the
// reference cannot tell "this locale does not ship that path" (TDC217) from "no such path
// anywhere" (TDC071), and would record the wrong code for the other four to match.
const PACKS = bundledPacks();
const PACK_ADDRESSES = [...PACKS.keys()];
const PACK_PARAMS = packParameterNames(PACKS);
const PACK_PARAM_WIDTHS = packParameterWidths(PACKS);

/**
 * Parse and validate, returning `severity code line:column` per diagnostic, in report order.
 *
 * A parse error stops the run: there is no tree to validate, and the parser's own complaint is
 * the only honest thing to report.
 */
export function diagnoseCase(source: string, dataPath?: string): string[] {
  const parsed = parse(source);
  if (parsed.diagnostics.length > 0) {
    // A parser diagnostic carries no severity of its own — refusing to parse is never advisory,
    // so every consumer (the CLI renderer, the LSP) states `error` for it, and so does this.
    // Without that the reference would record `undefined` where the four ports record `error`.
    // `PARSE`, flatly: a ParserDiagnostic carries no code, and the `?? 'PARSE'` this used to
    // be written as could never take its left branch — typing the module is what showed that.
    // Nine cases in the fixtures expect exactly this, so the behaviour is unchanged.
    return parsed.diagnostics.map((d) => `error PARSE ${String(d.line)}:${String(d.column)}`);
  }
  return validate(parsed.tree, {
    packAddresses: PACK_ADDRESSES,
    packParams: PACK_PARAMS,
    packParamWidths: PACK_PARAM_WIDTHS,
    // A case may need a real file on disk — TDC062 is about a CSV column that is not in the
    // header, and there is no way to say that without a header to be absent from.
    ...(dataPath ? { dataSources: { baseDir: join(DIAGNOSTICS_DIR, dataPath) } } : {}),
  }).diagnostics.map((d) => `${d.severity} ${d.code ?? '?'} ${String(d.line)}:${String(d.column)}`);
}
