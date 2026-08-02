/**
 * Generators module public surface.
 *
 * Text/file/template/number/counter sources are available to the
 * sequence engine, the renderer, and callers that need the lower-level
 * generator primitives.
 */

export type { Generator } from './generator.js';
export { textUniform, textWithPercents } from './text.js';
export {
  csvColumnCell,
  fileUniform,
  loadCsvColumnFile,
  loadCsvColumnSource,
  loadFileValues,
  loadListFile,
  parseCsvRows,
} from './file.js';
export type {
  CsvColumnSource,
  FileSourceOptions,
  FileValueLoader,
  LegacyListLoader,
} from './file.js';
export { numberGenerator } from './number.js';
export type { NumberGenAttrs } from './number.js';
export {
  DEFAULT_REGEX_MAX_LENGTH,
  RegexGeneratorError,
  parseRegexMaxLength,
  parseRegexProgram,
  regexGenerator,
} from './regex.js';
export type { RegexGenAttrs, RegexProgram } from './regex.js';
export {
  AdvancedRegexGeneratorError,
  advancedRegexGenerator,
  parseAdvancedRegexProgram,
} from './advanced-regex.js';
export type { AdvancedRegexGenAttrs, AdvancedRegexProgram } from './advanced-regex.js';
export { symbolGenerator, parseSymbolLength, SymbolGeneratorError } from './symbol.js';
export type { SymbolGenAttrs } from './symbol.js';
export { dateGenerator, parsePrecision } from './date.js';
export type { DateGenAttrs } from './date.js';
export { incrementGenerator, decrementGenerator } from './counter.js';
export type { CounterAttrs } from './counter.js';
