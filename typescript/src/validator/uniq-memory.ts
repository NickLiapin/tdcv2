/**
 * `uniq` over many rows holds the whole column in memory — say so before the run.
 *
 * A `<pool>` already warns at 100,000 members (TDC234), because it is built in
 * full before the first row. `uniq` on a sequence does exactly the same thing —
 * drawing without replacement means remembering what has been drawn — and said
 * nothing at all. Measured before this check existed: 1,600,000 rows peaked at
 * 453 MB, and the run gave no clue why.
 *
 * The asymmetry was the whole reason to add it. Two constructs with the same
 * cost, one of which announces itself and one of which does not, is the kind of
 * gap a reader cannot be expected to close on their own.
 *
 * ── Where it shows up ────────────────────────────────────────────────────────
 * This is a VALIDATOR warning, which is what makes it useful. `tdcv2 check`
 * generates nothing and prints it instantly, so Studio can run check before a
 * run and warn while it is still free. On a real run it goes to stderr ahead of
 * the engine — measured at 341 ms against the first row at 1795 ms — so there is
 * time to stop, and stdout stays clean for a pipe either way.
 *
 * ── Where the number comes from ─────────────────────────────────────────────
 * MEASURED, not guessed: peak RSS against row count, three runs at each size,
 * smallest kept, every run checked for a zero exit and a full output file.
 *
 *     200,000 rows   154.5 MB      800,000 rows   305.6 MB
 *     400,000 rows   223.2 MB    1,600,000 rows   453.0 MB
 *
 * The SLOPE is what matters — everything that does not grow with rows (Node
 * itself, the pack loader, the output buffer) drops out of it. Over that
 * eight-fold range it holds between 193 and 224 bytes a value for integers; an
 * 11-character string column measured 257 on its clean stretch. 250 is the
 * round number that covers both, and the message says "about".
 *
 * A first attempt subtracted a baseline run without `uniq` and produced NEGATIVE
 * costs, because a config without `uniq` streams and one with it does not — the
 * subtraction was comparing two different engines. The slope needs no baseline.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';

import { nodeRange } from '../errors/source-map.js';

/**
 * Bytes a value costs while `uniq` is holding the column.
 *
 * See the measurement in the header. Deliberately round: reporting 224 would
 * claim a precision the figure does not have, and it moves with value length.
 */
const BYTES_PER_VALUE = 250;

/**
 * Where to start talking, matching `<pool>`'s TDC234 threshold.
 *
 * Below this the cost is tens of megabytes and nobody needs telling; 100,000
 * values is about 24 MB. The two constructs cost the same, so they warn at the
 * same size — a different threshold for each would be a detail to look up.
 */
const WARN_ROWS = 100_000;

function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024
    ? `${(mb / 1024).toFixed(1)} GB`
    : `${Math.round(mb).toLocaleString('en-US')} MB`;
}

/**
 * Warn when a sequence carrying `uniq="true"` will hold a large column.
 *
 * `count` is the run length, already parsed by the caller — a config whose count
 * did not parse has an error of its own and is not made clearer by this.
 */
export function checkUniqMemory(
  node: OpenCloseElementContext | SelfClosingElementContext,
  name: string,
  count: number,
  diagnostics: Diagnostic[],
): void {
  if (count < WARN_ROWS) return;
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...nodeRange(node),
    message:
      `uniq on "${name}" costs about ${megabytes(count * BYTES_PER_VALUE)} at ` +
      `${count.toLocaleString('en-US')} rows — memory that follows the row count`,
    hint:
      'Keeping a promise about the finished column costs memory that follows count, on every ' +
      'engine — the cost belongs to the promise, not to one of them. About 250 bytes a value, ' +
      'measured; a compound uniq measures higher still. A single drawn column pays twice: ' +
      'drawing without replacement cannot be done a row at a time, so that shape also runs in ' +
      'memory whatever mode= asks for. It works — it is worth being deliberate about at this size.',
    code: 'TDC299',
  });
}
