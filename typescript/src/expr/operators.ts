/**
 * Operators added to jsep's default table, registered in one place.
 *
 * jsep keeps its operator table as MODULE STATE, so registering `in` inside the
 * evaluator worked only when the evaluator had been imported first. The
 * validator imports jsep directly and does not import the evaluator, so
 * `check` — and the LSP with it — saw `Country in [US, CA]` as a syntax error
 * while a run accepted it. A config the validator called broken and the engine
 * ran happily is the worst shape that disagreement can take.
 *
 * Importing this module is the whole contract. Both sides do, before they parse.
 */

import jsep from 'jsep';

/**
 * `in` sits with the relational operators (precedence 7), which is where a
 * reader expects it: `A in [x, y] && B == 1` groups the way it reads.
 */
jsep.addBinaryOp('in', 7);

/** Imported for the side effect above; the value exists so the import is not elided. */
export const EXPR_OPERATORS_REGISTERED = true;
