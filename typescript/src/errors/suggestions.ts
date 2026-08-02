/**
 * Edit-distance-based "did you mean X?" suggestions.
 *
 * Used when the user references an unknown name — template path,
 * generator type, sequence identifier — and we have a closed list of
 * known candidates. If one candidate is "close enough" (small edit
 * distance, same ballpark length), we point at it in the diagnostic's
 * `suggestion` field.
 *
 * Classic Damerau-Levenshtein is overkill here; plain Levenshtein
 * handles the common typos (single insertion / deletion / substitution)
 * which is what we care about. Transpositions ("frist" → "first") cost 2
 * edits instead of 1 but still rank top of the list for realistic
 * candidate sets.
 */

function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return prev[n]!;
}

/**
 * Find the candidate closest to `needle`. Returns `undefined` if the
 * best distance exceeds `maxDistance` OR exceeds ~half the needle length
 * (what feels like a typo shouldn't exceed that).
 *
 * Case-insensitive match is tried first — most DSL typos are in casing
 * (e.g. `person.male.firstname` vs `person.male.firstName`) and we want
 * those to score 0.
 */
export function closestMatch(
  needle: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | undefined {
  if (needle.length === 0 || candidates.length === 0) return undefined;

  const limit = Math.min(maxDistance, Math.max(1, Math.floor(needle.length / 2) + 1));
  const lowerNeedle = needle.toLowerCase();

  // Exact match on case difference first — always win.
  for (const c of candidates) {
    if (c.toLowerCase() === lowerNeedle && c !== needle) return c;
  }

  let bestName: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = distance(needle, c);
    if (d < bestDist) {
      bestDist = d;
      bestName = c;
    }
  }
  return bestDist <= limit ? bestName : undefined;
}

/** Format an array of candidates as "a, b, c" for diagnostic hints. */
export function formatCandidates(candidates: readonly string[], max = 6): string {
  if (candidates.length <= max) return candidates.join(', ');
  return candidates.slice(0, max).join(', ') + `, … (${String(candidates.length - max)} more)`;
}
