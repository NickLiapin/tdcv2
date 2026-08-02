package io.github.nickliapin.tdc.engine;

import java.util.List;

/**
 * A finished run, seen from the outside: how many records, what they are called, what a given
 * record holds.
 *
 * <p>What the public API needs, and the only thing the engines have to agree on. One holds every
 * column in memory and answers instantly; another computes the value when asked and forgets it
 * again. A caller iterating rows cannot tell which it has, which is the point — the engine is a
 * performance decision, not a difference in the data.
 */
public interface RowSource {

  /** The number of records. */
  int count();

  /** The declared sequences, in declaration order; the built-in {@code _}-names are left out. */
  List<String> sequenceNames();

  /** One value, or {@code null} when the sequence does not apply to that record. */
  String value(String column, int row);

  /** The whole run as text — what the config's {@code <data>} block produces. */
  String text();

  /**
   * The same output, written out rather than returned.
   *
   * <p>The default builds the string first, which is right for a source that already holds the
   * whole run. A streaming source overrides it to write record by record — otherwise the one
   * call that most needs bounded memory would be the one that assembles the entire output first.
   */
  default void writeTo(Appendable out) {
    try {
      out.append(text());
    } catch (java.io.IOException e) {
      throw new java.io.UncheckedIOException("cannot write the generated data", e);
    }
  }
}
