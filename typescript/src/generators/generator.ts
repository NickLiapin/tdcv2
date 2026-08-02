/**
 * The `Generator` contract.
 *
 * A generator materializes the values that populate a sequence. At
 * sequence-build time the generator is invoked with the total `count`
 * of cells to produce and a seeded PRNG; it returns a fixed-length
 * array whose entries are the concrete per-cell values.
 *
 * All generators are therefore deterministic on the same
 * (count, prng-state) pair. Python and Java ports must preserve the
 * same materialization semantics to keep cross-language outputs
 * byte-identical.
 *
 * See docs/vision/02-sequences.md for the high-level model and
 * docs/vision/10-generators.md for the generator-type roadmap.
 */

export type Generator = (count: number, prng: () => number) => readonly string[];
