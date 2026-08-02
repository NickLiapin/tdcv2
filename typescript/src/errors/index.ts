/**
 * Public surface of the errors module — diagnostic types, formatter,
 * suggestions, and the canonical error class thrown across the pipeline.
 */

export {
  type Diagnostic,
  type DiagnosticSeverity,
  type DiagnosticSource,
  hasErrors,
} from './diagnostic.js';
export { formatDiagnostic, formatDiagnostics, type FormatOptions } from './format.js';
export { TdcDiagnosticError } from './TdcDiagnosticError.js';
export { closestMatch, formatCandidates } from './suggestions.js';
export {
  type Pos,
  type Range,
  nodePos,
  nodeRange,
  tokenPos,
  tokenRange,
  attrNameRange,
  attrValueRange,
} from './source-map.js';
