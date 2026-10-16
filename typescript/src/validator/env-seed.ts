/**
 * An `<env>` with no `seed=`: a file that will not come out the same twice.
 *
 * Nothing about it is wrong, which is why it is a warning — some runs want fresh
 * data every time. But "same seed, same bytes" is the promise the rest of the
 * engine keeps, and a config handed to somebody else without a seed breaks it
 * silently: two runs, two different files, and `check` called both valid. An
 * agent writing a config for a person is the case that made this worth saying.
 *
 * What a RUN knows that a config does not: a seed given from outside (`--seed`,
 * or the API's `seed` option) fixes the file after all, and a run without one
 * prints the seed it drew. So the run takes this warning back in both cases —
 * see `TDC` — and it is `check` and the editor that show it.
 */

import { type Diagnostic, nodeRange, tokenRange } from '../errors/index.js';
import type { OpenCloseElementContext } from '../generated/TDCParser.js';

export const NO_SEED_CODE = 'TDC309';

export function checkEnvSeed(envEl: OpenCloseElementContext, diagnostics: Diagnostic[]): void {
  if (envEl.attr().some((a) => a._attrName?.text === 'seed')) return;
  const name = envEl._name;
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...(name ? tokenRange(name) : nodeRange(envEl)),
    message: '<env> has no seed=, so every run draws a different file',
    hint:
      'Add seed="…" — any text will do — and this config gives the same bytes on every run, ' +
      'in all five implementations. Leave it out only when fresh data each time is the point.',
    code: NO_SEED_CODE,
  });
}
