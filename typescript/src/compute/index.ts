/**
 * Public surface of the `compute` declarative computation layer.
 *
 * See docs/specs/2026-07-18-compute-declarative-computation-layer.md.
 */

export { evaluateCompute, evaluateComputePredicate, type EvalScope } from './evaluate.js';
export { ComputeError, type Value } from './value.js';
export { ENCODINGS, type Encoding } from './encode.js';
