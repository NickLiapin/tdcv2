/**
 * TDC — The Data Constructor.
 *
 * TypeScript reference implementation. See docs/vision/START_HERE.md at
 * the repo root for project overview and development plan.
 *
 * Phase 1 (Weeks 2-3): parser pipeline.
 * Phase 2 (Weeks 4-6): PRNG, Hamilton distribution, text & file generators.
 * Phase 3 (Weeks 7-8): processor — parse → render → output. The five
 *   canonical fixtures in /fixtures/*.xml produce byte-identical output
 *   to the 2022-2024 prototype.
 * Phase 4 (Weeks 9-10): sequence engine — `<sequence>` with
 *   `parent="X.Value"` dotnotation, pre-materialized before rendering,
 *   accessed via interpolation. See fixtures/tdc_sequence_demo.xml.
 * Phase 5 (Weeks 11-12): if-attribute expressions, number, increment,
 *   decrement generators. See fixtures/tdc_conditional_demo.xml.
 * Phase 6 (Weeks 13-16): `TDC` class library facade, command-line
 *   interface, release prep. This is the shape user code imports as:
 *     `import { TDC } from 'tdcv2';`
 */

export { VERSION, SUPPORTED_DSL_VERSION, compareVersions } from './version.js';

export { parse, parseStrict, TdcParseError } from './parser/index.js';
export type { ParseResult, ParserDiagnostic } from './parser/index.js';

export { formatTdc } from './formatter/index.js';

// Validator + diagnostics — the "toolable" surface an editor / LSP consumes:
// validate() produces line/column diagnostics; the KNOWN_* lists feed
// autocomplete.
export {
  validate,
  KNOWN_GEN_TYPES,
  KNOWN_TEMPLATE_PATHS,
  BUILTIN_SEQUENCES,
} from './validator/index.js';
export type { ValidationOptions, ValidationResult } from './validator/index.js';
export { hasErrors } from './errors/index.js';
export type { Diagnostic, DiagnosticSeverity, DiagnosticSource } from './errors/index.js';

export { createPrng, cyrb128, sfc32, randomInt, randomPick, shuffle } from './prng/index.js';

export { distributeByPercent, computeCountsPerValue } from './distribution/index.js';
export type { DistributeOptions } from './distribution/index.js';
export { PercentMaskError, expandPercentMask } from './distribution/index.js';

export {
  csvColumnCell,
  textUniform,
  textWithPercents,
  fileUniform,
  loadCsvColumnFile,
  loadCsvColumnSource,
  loadFileValues,
  loadListFile,
  parseCsvRows,
} from './generators/index.js';
export type {
  CsvColumnSource,
  FileSourceOptions,
  FileValueLoader,
  Generator,
  LegacyListLoader,
} from './generators/index.js';

export { render } from './processor/index.js';
export type { RenderOptions } from './processor/index.js';

export { resolveTemplate, registerTemplate } from './templates/index.js';
export type { TemplateSource } from './templates/index.js';

export { buildSequences, extractSequenceSpecs } from './sequence/index.js';
export type { GenSpec, Sequence, SequenceRegistry, SequenceSpec } from './sequence/index.js';

export { TDC } from './lib/index.js';
export type {
  TdcObjectRow,
  TdcObjectScalar,
  TdcObjectValue,
  TdcOptions,
  TdcPreflightOptions,
} from './lib/index.js';

export { evaluateIf } from './expr/index.js';

export {
  DataSourceResolutionError,
  formatDataSourceAttempts,
  resolveDataSourcePath,
  resolveExistingDataSourcePath,
} from './data-source/index.js';
export type { DataSourceOptions, DataSourceResolution } from './data-source/index.js';

export {
  parsePackFile,
  scanPacks,
  clearPackCache,
  pathToAddress,
  bundledPacksDir,
} from './data-pack/index.js';
export type { ParsedPackFile, PackEntry, PackRegistry, ScanResult } from './data-pack/index.js';

export {
  numberGenerator,
  regexGenerator,
  symbolGenerator,
  dateGenerator,
  incrementGenerator,
  decrementGenerator,
} from './generators/index.js';
export type {
  NumberGenAttrs,
  RegexGenAttrs,
  SymbolGenAttrs,
  DateGenAttrs,
  CounterAttrs,
} from './generators/index.js';
export {
  formatDateTime,
  parseDateRangeValue,
  parseDateTimeStrict,
  parseLegacyDateRange,
  resolveDateLocale,
} from './date/index.js';
export type { DatePrecision, PlainDateTime } from './date/index.js';
export {
  ALPHABET_DEFINITIONS,
  ALPHABET_NAMES,
  resolveAlphabet,
  resolveAlphabetChars,
} from './unicode/alphabets.js';
export type { AlphabetDefinition } from './unicode/alphabets.js';

// The quick API — one value without a config file. A thin adapter over the
// same engine: `tdc.person.male.firstName()`, `tdc.gen.number('20..30')`.
export {
  tdc,
  TdcQuickError,
  RESERVED_ROOT_NAMES,
  RESERVED_PATH_NAMES,
  BATCH_ROWS,
} from './quick/index.js';
export type { QuickParams } from './quick/index.js';
