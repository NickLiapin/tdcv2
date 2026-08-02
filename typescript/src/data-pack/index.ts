/**
 * Data packs — self-describing data modules.
 *
 * Public surface: parse a pack file, scan directories into a registry,
 * and locate the bundled pack directory.
 */

export { parsePackFile, type ParsedPackFile } from './parse.js';
export {
  parseGeneratorSpec,
  PRIMITIVE_GENERATOR_TYPES,
  type GeneratorBody,
  type GeneratorParseResult,
  type ParsedGenerator,
} from './generator.js';
export {
  scanPacks,
  clearPackCache,
  pathToAddress,
  bundledPacksDir,
  bundledPacks,
  type PackEntry,
  type PackRegistry,
  packParameterNames,
  type ScanResult,
} from './load.js';
export {
  CANONICAL_LOCALES,
  CANONICAL_COUNTRIES,
  RTL_LOCALES,
  RESERVED_BUCKETS,
  directionOf,
  resolvePackAddress,
  parseLocaleManifest,
  MANIFEST_FILENAME,
  type Direction,
  type LocaleManifest,
} from './locales.js';
