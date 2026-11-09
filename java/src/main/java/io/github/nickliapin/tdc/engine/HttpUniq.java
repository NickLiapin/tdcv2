package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.model.Config;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.function.IntFunction;

/**
 * {@code uniq="true"} on a {@code <gen type="http">} sequence: a CHECK of the answers.
 *
 * <p>Everywhere else {@code uniq} is a property of a draw — take without replacement, or rearrange
 * — and a service's answer is neither: it belongs to the row it was asked for, and the service
 * answers each row once. So the run cannot MAKE the column unique. What it can do is refuse to
 * write a file that claims to be unique and is not: every answer is read once, before the first
 * row goes out, and the first repeat stops the run with the two rows that share it.
 *
 * <p>The hunt is an external sort, so it holds a sort buffer, not the column. A blank answer is no
 * value at all ({@code on_error="empty"}, a {@code parent=} row the child does not hold, a {@code
 * missing=} draw) and repeats freely. Mirrors {@code typescript/src/sequence/http-uniq.ts}.
 */
public final class HttpUniq {
  private static final char SEP = '\u0000';
  private static final int INDEX_WIDTH = 16;

  private HttpUniq() {}

  /** The sequences whose {@code uniq="true"} is a check of a service's answers. */
  public static List<String> sequences(Config config) {
    List<String> out = new ArrayList<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.uniq() && spec.gen() != null && "http".equals(spec.gen().type())) {
        out.add(spec.name());
      }
    }
    return out;
  }

  /** Throw, naming the first repeated answer, unless every non-blank answer differs. */
  public static void check(String name, IntFunction<String> value, int count) {
    Iterator<String> records =
        new Iterator<>() {
          private int row;
          private String ready = advance();

          private String advance() {
            while (row < count) {
              int i = row++;
              String key = value.apply(i);
              if (key != null && !key.isEmpty()) {
                String index = String.valueOf(i);
                return key + SEP + "0".repeat(INDEX_WIDTH - index.length()) + index;
              }
            }
            return null;
          }

          @Override
          public boolean hasNext() {
            return ready != null;
          }

          @Override
          public String next() {
            if (ready == null) {
              throw new NoSuchElementException();
            }
            String out = ready;
            ready = advance();
            return out;
          }
        };
    // The groups arrive in key order; the one reported is the first a reader of the file would
    // meet — the lowest row that repeats an answer above it.
    int[] first = null;
    int repeats = 0;
    String current = null;
    List<Integer> group = new ArrayList<>();
    Iterator<String> sorted =
        ExternalSort.sort(records, 0, java.nio.file.Path.of(System.getProperty("java.io.tmpdir")));
    while (true) {
      String record = sorted.hasNext() ? sorted.next() : null;
      String key = null;
      int index = -1;
      if (record != null) {
        int split = record.lastIndexOf(SEP);
        key = record.substring(0, split);
        index = Integer.parseInt(record.substring(split + 1));
      }
      if (record == null || !key.equals(current)) {
        if (group.size() >= 2) {
          repeats += group.size() - 1;
          if (first == null || group.get(1) < first[1]) {
            first = new int[] {group.get(0), group.get(1)};
          }
        }
        group = new ArrayList<>();
        current = key;
      }
      if (record == null) {
        break;
      }
      group.add(index);
    }
    if (first == null) {
      return;
    }
    String answer = value.apply(first[0]);
    throw new IllegalStateException(
        "uniq=\"true\" on \"" + name + "\": the service answered \""
            + (answer == null ? "" : answer) + "\" on row " + (first[0] + 1)
            + " and again on row " + (first[1] + 1)
            + (repeats > 1 ? " (" + repeats + " rows repeat an earlier answer)" : "")
            + " — uniq on an http column checks the answers; it cannot ask the service for"
            + " others");
  }
}
