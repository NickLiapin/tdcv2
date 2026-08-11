/**
 * `distinct="true"` for a generator that DRAWS rather than picks from a list.
 *
 * A listed column has a pool to draw down, so it uses `drawDistinct` in
 * `repeat.ts`. A number, a date, a regex or a template has no such pool — the
 * only way to get a fresh value is to ask again on a different sub-stream. That
 * is rejection sampling, and it lives here so both engines run the identical
 * loop against the identical stream ids: the memory engine and the streaming
 * engine must land on the same values, and a second copy of this loop is how
 * they would quietly stop doing so.
 */

import { DISTINCT_MAX_TRIES, RepeatError } from './repeat.js';

/**
 * Ask `draw` for a value that is not already in `seen`.
 *
 * `draw` receives the sub-stream suffix to use: the empty string for the first
 * attempt (so a config WITHOUT `distinct` reads the very same stream and the
 * two produce identical output up to the first collision), then `r1`, `r2` and
 * so on.
 *
 * Exhausting the tries throws rather than returning a duplicate or a short
 * list. `<gen type="regex" value="[01]" repeat="5" distinct="true">` cannot be
 * satisfied by anything, and saying so is the entire point of the attribute.
 */
export function redrawUntilFresh(
  seen: readonly string[],
  genType: string,
  draw: (suffix: string) => string,
): string {
  return redrawUntilFreshAt(seen, genType, draw).value;
}

/**
 * The same loop, reporting WHICH sub-stream won.
 *
 * The anomaly flag needs this. A flag is resolved by re-running the element's draw and
 * asking whether it spiked — and under `distinct` the value that survived may have come
 * from `r3` rather than the first attempt. Resolving the flag on the first attempt would
 * describe a value that was thrown away: the list would say `false` beside a number that
 * plainly spiked, which is worse than no flag at all.
 */
export function redrawUntilFreshAt(
  seen: readonly string[],
  genType: string,
  draw: (suffix: string) => string,
): { value: string; suffix: string } {
  let suffix = '';
  let value = draw(suffix);
  for (let attempt = 1; seen.includes(value) && attempt <= DISTINCT_MAX_TRIES; attempt++) {
    suffix = `r${String(attempt)}`;
    value = draw(suffix);
  }
  if (seen.includes(value)) {
    throw new RepeatError(
      `repeat with distinct="true" could not find ${String(seen.length + 1)} different values for ` +
        `<gen type="${genType}"> after ${String(DISTINCT_MAX_TRIES)} tries — the generator does ` +
        'not produce that many',
    );
  }
  return { value, suffix };
}
