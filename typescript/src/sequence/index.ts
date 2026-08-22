/**
 * Sequence module public surface.
 */

export { checkEnvUniqCapacity } from './uniq-capacity.js';
export { buildSequences, runGenerator } from './build.js';
export type { SequenceBuildOptions } from './build.js';
export { resolveGenValueAt } from './gen-resolve.js';
export { buildLazyRegistry, StreamUnsupportedError } from './stream-build.js';
export { buildExactDiskRegistry } from './exact-disk.js';
export {
  extractAsserts,
  extractEnvDistinctGroups,
  extractEnvUniqGroups,
  extractSequenceSpecs,
} from './extract.js';
export { sequenceValueAt } from './types.js';
export type {
  CaseSpec,
  GenSpec,
  Sequence,
  SequenceRegistry,
  SequenceSpec,
  SwitchSpec,
} from './types.js';
