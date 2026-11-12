package io.github.nickliapin.tdc.lib;

import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * A bounded cache for a parse whose answer depends on its text alone.
 *
 * <p>The streaming engine draws one value at a time, and for every row it asks a generator to read
 * its own attributes again — a regex pattern, a number range. Those are config constants, and
 * nothing changes a parsed tree after it is built, so parsing each text once gives the same
 * values. Measured: the pattern parse was a third of a regex-heavy run in the other four.
 *
 * <p>Cleared wholesale when full rather than tracking recency: a run holds a handful of keys, and
 * the limit only stops a long-lived process that builds many configs from growing without bound.
 * A parse that throws is not kept, so a bad pattern reports the same error every time. Safe to
 * share between the threads of a parallel run.
 */
public final class TextMemo<T> {
  private static final int LIMIT = 256;

  private final ConcurrentHashMap<String, T> entries = new ConcurrentHashMap<>();
  private final Function<String, T> parse;

  public TextMemo(Function<String, T> parse) {
    this.parse = parse;
  }

  public T get(String text) {
    T hit = entries.get(text);
    if (hit != null) {
      return hit;
    }
    T value = parse.apply(text);
    if (entries.size() >= LIMIT) {
      entries.clear();
    }
    entries.put(text, value);
    return value;
  }
}
