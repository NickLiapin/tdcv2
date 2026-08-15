/**
 * Distribution module public surface.
 */

export { distributeByPercent, computeCountsPerValue } from './hamilton.js';
export type { DistributeOptions } from './hamilton.js';
export { PercentMaskError, expandPercentMask, inferredZeros } from './percent-mask.js';
