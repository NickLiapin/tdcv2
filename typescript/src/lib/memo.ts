/**
 * A bounded cache for a parse whose answer depends on its text alone.
 *
 * The streaming engines draw one value at a time, and for every row they ask a
 * generator to read its own attributes again — a regex pattern, a number range.
 * Those are config constants, and nothing changes a parsed tree after it is
 * built, so parsing each text once gives the same values. Measured: the pattern
 * parse was a third of a regex-heavy run.
 *
 * Cleared wholesale when full rather than tracking recency: a run holds a
 * handful of keys, and the limit only stops a long-lived process that builds
 * many configs from growing without bound. A parse that throws is not cached, so
 * a bad pattern reports the same error every time.
 */
export function memoByText<T>(parse: (text: string) => T, limit = 256): (text: string) => T {
  const cache = new Map<string, T>();
  return (text) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const value = parse(text);
    if (cache.size >= limit) cache.clear();
    cache.set(text, value);
    return value;
  };
}
