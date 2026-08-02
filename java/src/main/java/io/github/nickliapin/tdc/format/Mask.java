package io.github.nickliapin.tdc.format;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A positional mask: {@code mask="xxx-xxx"}, {@code mask="w[1] w[0]"}, {@code mask="x[0]. *"}.
 *
 * <p>The alphabet is small on purpose. {@code x} takes one character, {@code w} takes one word,
 * {@code *} takes everything not yet used, a backslash escapes the next character, and anything
 * else is a literal. That is enough to reformat a phone number, swap a name around, or build an
 * initial, without a config ever reaching for a regular expression.
 *
 * <p>{@code x[i]} and {@code w[i]} address the <em>original</em> input — 0-based, negative from
 * the end, {@code a..b} inclusive. Indexing and consumption are two channels that do not
 * interfere: what an index emits never depends on what has been consumed, and consumption only
 * decides what is left for a bare {@code x}, {@code w} or {@code *}. So the same notation reads
 * as a move when nothing else claims that position and as a copy when something does — which is
 * why {@code "w[1] w[0]"} swaps two words and {@code "w[0] *"} repeats the first one.
 *
 * <p>Out-of-range indexes emit nothing rather than failing. The length of a value is not known
 * until it is generated, so there is nothing to check the mask against beforehand, and stopping
 * a million-row run over one short value would be worse than a gap in it.
 */
public final class Mask {

  private static final Pattern ONE_INDEX = Pattern.compile("^(-?\\d+)$");
  private static final Pattern RANGE_INDEX = Pattern.compile("^(-?\\d+)\\.\\.(-?\\d+)$");

  private enum Kind {
    CHAR,
    WORD,
    CHAR_AT,
    WORD_AT,
    REST,
    LITERAL
  }

  private record Slot(Kind kind, String text, int from, int to) {}

  private record Span(int start, int end) {}

  private Mask() {}

  public static String apply(String pattern, String input) {
    List<String> chars = codePoints(input);
    boolean[] used = new boolean[chars.size()];
    List<Span> spans = wordSpans(chars);
    StringBuilder out = new StringBuilder();

    for (Slot slot : parse(pattern)) {
      switch (slot.kind()) {
        case LITERAL -> out.append(slot.text());

        case CHAR -> {
          int i = nextFree(used);
          if (i < chars.size()) {
            out.append(chars.get(i));
            used[i] = true;
          }
        }

        case WORD -> {
          int i = nextFree(used);
          while (i < chars.size() && !used[i] && !isSpace(chars.get(i))) {
            out.append(chars.get(i));
            used[i] = true;
            i++;
          }
          // Swallow one delimiter with the word, so what a later `*` prints does not begin
          // with the space this word left behind.
          if (i < chars.size() && !used[i] && isSpace(chars.get(i))) {
            used[i] = true;
          }
        }

        case CHAR_AT -> {
          for (int i : walk(slot.from(), slot.to(), chars.size())) {
            out.append(chars.get(i));
            used[i] = true;
          }
        }

        case WORD_AT -> {
          List<String> picked = new ArrayList<>();
          for (int wi : walk(slot.from(), slot.to(), spans.size())) {
            Span span = spans.get(wi);
            for (int i = span.start(); i < span.end(); i++) {
              used[i] = true;
            }
            // Take one adjacent delimiter along, so the leftovers a later `*` prints do not
            // collapse into a double space.
            if (span.end() < chars.size() && isSpace(chars.get(span.end()))) {
              used[span.end()] = true;
            } else if (span.start() > 0 && isSpace(chars.get(span.start() - 1))) {
              used[span.start() - 1] = true;
            }
            picked.add(String.join("", chars.subList(span.start(), span.end())));
          }
          out.append(String.join(" ", picked));
        }

        case REST -> {
          for (int i = 0; i < chars.size(); i++) {
            if (!used[i]) {
              out.append(chars.get(i));
              used[i] = true;
            }
          }
        }
      }
    }
    return out.toString();
  }

  /**
   * Parse a mask without applying it — what the validator needs to refuse a broken one early.
   *
   * <p>Throws the same complaint applying it would, only before a single row exists.
   */
  public static void check(String pattern) {
    parse(pattern);
  }

  private static List<Slot> parse(String pattern) {
    List<String> pat = codePoints(pattern);
    List<Slot> slots = new ArrayList<>();
    for (int i = 0; i < pat.size(); i++) {
      String ch = pat.get(i);
      if ("\\".equals(ch) && i + 1 < pat.size()) {
        slots.add(new Slot(Kind.LITERAL, pat.get(i + 1), 0, 0));
        i++;
        continue;
      }
      if ("*".equals(ch)) {
        slots.add(new Slot(Kind.REST, null, 0, 0));
        continue;
      }
      if (!"x".equals(ch) && !"w".equals(ch)) {
        slots.add(new Slot(Kind.LITERAL, ch, 0, 0));
        continue;
      }

      // A `[` is index syntax only directly after an x or a w. Anywhere else it is ordinary
      // text, so mask="[tel.] xxx" needs no escaping.
      if (i + 1 < pat.size() && "[".equals(pat.get(i + 1))) {
        int close = indexOf(pat, "]", i + 2);
        if (close != -1) {
          String body = String.join("", pat.subList(i + 2, close));
          int[] spec = parseIndexSpec(body);
          if (spec == null) {
            throw new IllegalArgumentException(
                "mask: invalid index \"["
                    + body
                    + "]\" after \""
                    + ch
                    + "\" — use "
                    + ch
                    + "[0], "
                    + ch
                    + "[0..4] or "
                    + ch
                    + "[-1]; ranges use \"..\" (a hyphen would clash with a negative index)."
                    + " For a literal bracket write "
                    + ch
                    + "\\[");
          }
          slots.add(
              new Slot("x".equals(ch) ? Kind.CHAR_AT : Kind.WORD_AT, null, spec[0], spec[1]));
          i = close;
          continue;
        }
        // No closing bracket anywhere: plain text, left alone.
      }
      slots.add(new Slot("x".equals(ch) ? Kind.CHAR : Kind.WORD, null, 0, 0));
    }
    return slots;
  }

  /** {@code -3}, {@code 7}, {@code 0..4}, {@code -2..-1} — and nothing else. */
  private static int[] parseIndexSpec(String body) {
    Matcher one = ONE_INDEX.matcher(body);
    if (one.matches()) {
      int n = Integer.parseInt(one.group(1));
      return new int[] {n, n};
    }
    Matcher range = RANGE_INDEX.matcher(body);
    if (!range.matches()) {
      return null;
    }
    return new int[] {Integer.parseInt(range.group(1)), Integer.parseInt(range.group(2))};
  }

  /** Indices from..to inclusive, counting backwards when the range runs that way. */
  private static List<Integer> walk(int from, int to, int length) {
    int a = from < 0 ? length + from : from;
    int b = to < 0 ? length + to : to;
    int step = a <= b ? 1 : -1;
    List<Integer> out = new ArrayList<>();
    for (int i = a; step > 0 ? i <= b : i >= b; i += step) {
      if (i >= 0 && i < length) {
        out.add(i);
      }
    }
    return out;
  }

  private static List<Span> wordSpans(List<String> chars) {
    List<Span> spans = new ArrayList<>();
    int i = 0;
    while (i < chars.size()) {
      if (isSpace(chars.get(i))) {
        i++;
        continue;
      }
      int start = i;
      while (i < chars.size() && !isSpace(chars.get(i))) {
        i++;
      }
      spans.add(new Span(start, i));
    }
    return spans;
  }

  private static int nextFree(boolean[] used) {
    int i = 0;
    while (i < used.length && used[i]) {
      i++;
    }
    return i;
  }

  private static int indexOf(List<String> chars, String needle, int from) {
    for (int i = from; i < chars.size(); i++) {
      if (needle.equals(chars.get(i))) {
        return i;
      }
    }
    return -1;
  }

  private static boolean isSpace(String c) {
    return !c.isEmpty() && Character.isWhitespace(c.codePointAt(0));
  }

  public static List<String> codePoints(String value) {
    List<String> out = new ArrayList<>();
    value.codePoints().forEach(cp -> out.add(new String(Character.toChars(cp))));
    return out;
  }
}
