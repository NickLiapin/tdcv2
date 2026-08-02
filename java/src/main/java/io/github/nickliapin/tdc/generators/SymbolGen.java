package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Random;
import io.github.nickliapin.tdc.unicode.Alphabets;
import io.github.nickliapin.tdc.unicode.CharSet;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code <gen type="symbol" .../>} — characters, drawn one at a time.
 *
 * <p>The pool comes from either a named {@code alphabet} or an inline {@code value} set, never
 * both. To pick a whole word from a list, {@code <gen type="text">} is the tag; this one works
 * below the level of words.
 */
public final class SymbolGen {

  private static final int DEFAULT_LENGTH = 1;
  private static final int MAX_LENGTH = 1024;

  private SymbolGen() {}

  public static List<String> generate(Map<String, String> attrs, int count, Prng.Sfc32 prng) {
    List<String> chars = resolveChars(attrs);
    int length = parseLength(attrs.get("length"));
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      StringBuilder value = new StringBuilder();
      for (int pos = 0; pos < length; pos++) {
        value.append(Random.pick(prng, chars));
      }
      out.add(value.toString());
    }
    return out;
  }

  static int parseLength(String raw) {
    if (raw == null) {
      return DEFAULT_LENGTH;
    }
    int value;
    try {
      value = Integer.parseInt(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "symbol length must be an integer from 1 to " + MAX_LENGTH + ", got \"" + raw + "\"");
    }
    if (value <= 0 || value > MAX_LENGTH) {
      throw new IllegalArgumentException(
          "symbol length must be an integer from 1 to " + MAX_LENGTH + ", got \"" + raw + "\"");
    }
    return value;
  }

  static List<String> resolveChars(Map<String, String> attrs) {
    String value = blankToNull(attrs.get("value"));
    String alphabet = blankToNull(attrs.get("alphabet"));

    if (value != null && alphabet != null) {
      throw new IllegalArgumentException(
          "symbol generator: use either \"value\" (inline set) or \"alphabet\" (named), not both");
    }

    List<String> base;
    if (value != null) {
      base = CharSet.parse(value);
      if (base.isEmpty()) {
        throw new IllegalArgumentException(
            "symbol generator: value \"" + value + "\" produced an empty character set");
      }
    } else if (alphabet != null) {
      base = Alphabets.chars(alphabet);
      if (base == null) {
        throw new IllegalArgumentException(
            "unknown alphabet \"" + alphabet + "\"; known alphabets: " + String.join(", ", Alphabets.names()));
      }
    } else {
      throw new IllegalArgumentException(
          "symbol generator requires \"value\" (inline set like \"abc\" or \"[a-z]\") or \"alphabet\" (named); "
              + "known alphabets: "
              + String.join(", ", Alphabets.names()));
    }

    return applyIncludeExclude(base, attrs.get("include"), attrs.get("exclude"));
  }

  /** {@code (base ∪ include) − exclude}. Exclude is applied last, so it always has the last word. */
  private static List<String> applyIncludeExclude(
      List<String> base, String include, String exclude) {
    boolean hasInclude = include != null && !include.isEmpty();
    boolean hasExclude = exclude != null && !exclude.isEmpty();
    if (!hasInclude && !hasExclude) {
      return base;
    }

    Set<String> chars = new LinkedHashSet<>(base);
    if (hasInclude) {
      chars.addAll(CharSet.parse(include));
    }
    if (hasExclude) {
      CharSet.parse(exclude).forEach(chars::remove);
    }
    if (chars.isEmpty()) {
      throw new IllegalArgumentException(
          "symbol generator: the character set is empty after applying include/exclude");
    }
    return List.copyOf(chars);
  }

  private static String blankToNull(String s) {
    return s == null || s.isEmpty() ? null : s;
  }
}
