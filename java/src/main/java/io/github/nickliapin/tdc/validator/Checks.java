package io.github.nickliapin.tdc.validator;

import io.github.nickliapin.tdc.date.DateLocales;
import io.github.nickliapin.tdc.format.Transforms;
import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.generators.NumberGen;
import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.unicode.Alphabets;
import io.github.nickliapin.tdc.unicode.CharSet;
import java.util.List;
import java.util.Set;

/**
 * The per-generator rules, kept apart from the structural ones so neither file grows unreadable.
 *
 * <p>Most of these work by handing the attribute to the generator's own parser and reporting
 * what it says. That is deliberate: a validator with its own idea of what a valid range looks
 * like drifts from the generator that actually reads it, and then a config passes validation and
 * fails at run time — the worst of both.
 */
final class Checks {

  /** Names the engine owns; a sequence may not claim one. */
  static final Set<String> BUILTINS = Set.of("_count", "_first", "_last", "_total", "_item", "_item_id");

  /** Attributes a named distribution replaces, so carrying both is a contradiction. */
  static final Set<String> DISTRIBUTION_CONFLICTS = Set.of("value", "percent", "length", "include", "exclude");

  private Checks() {}

  static boolean isBuiltin(String name) {
    return BUILTINS.contains(name);
  }

  /** {@code true} when the pattern parses under the finite subset. */
  static String regexProblem(String pattern, int maxLength) {
    try {
      RegexGen.compile(pattern, maxLength);
      return null;
    } catch (RuntimeException e) {
      return e.getMessage();
    }
  }

  static String advancedRegexProblem(String pattern, int maxLength) {
    try {
      AdvancedRegexGen.compile(pattern, maxLength);
      return null;
    } catch (RuntimeException e) {
      return e.getMessage();
    }
  }

  static String numberRangeProblem(String value) {
    try {
      NumberGen.parseRanges(value);
      return null;
    } catch (RuntimeException e) {
      return e.getMessage();
    }
  }

  static boolean isKnownAlphabet(String name) {
    return Alphabets.chars(name) != null;
  }

  static boolean isKnownDateLocale(String name) {
    return DateLocales.isKnown(name);
  }

  static boolean isKnownFilter(String name) {
    return Transforms.isFilterName(name);
  }

  static List<String> alphabetNames() {
    return Alphabets.names();
  }

  static boolean isBooleanText(String raw) {
    return "true".equals(raw) || "false".equals(raw);
  }

  /**
   * A length is a positive integer, a {@code min-max} range, or a comma-separated list of those.
   */
  static boolean isValidLength(String raw) {
    for (String part : raw.split(",", -1)) {
      String p = part.trim();
      if (!p.matches("^\\d+$") && !p.matches("^\\d+\\s*-\\s*\\d+$")) {
        return false;
      }
      for (String n : p.split("-")) {
        try {
          if (Integer.parseInt(n.trim()) <= 0) {
            return false;
          }
        } catch (NumberFormatException e) {
          return false;
        }
      }
    }
    return true;
  }

  /** Generator types on which {@code repeat=} is refused, and why. */
  static String repeatUnsupportedReason(String type) {
    return switch (type == null ? "" : type) {
      case "increment", "decrement", "timeseries", "pattern" ->
          "its value depends on the row index, which a variable-length list makes unknowable";
      default -> null;
    };
  }

  static boolean hasRepeat(java.util.Map<String, String> attrs) {
    return Repeat.parse(attrs) != null;
  }

  /**
   * How many different values this generator can offer, when the config alone says so.
   *
   * <p>{@code null} means "not knowable here" — never a guess. A pack file, a regex or a date
   * shape is read while generating, so those fall to the run-time refusal instead.
   */
  static Integer distinctPoolSize(String type, java.util.Map<String, String> attrs) {
    String value = attrs.getOrDefault("value", "").trim();
    if (value.isEmpty() || type == null) {
      return null;
    }

    if ("text".equals(type)) {
      java.util.Set<String> seen = new java.util.LinkedHashSet<>();
      for (String part : value.split(",", -1)) {
        seen.add(part.trim());
      }
      return seen.size();
    }

    // A one-character symbol draws from its inline set, so the set IS the pool. Only the plain
    // shape is counted: a named `alphabet`, `include`/`exclude`, or a length above one all change
    // the answer, and a refusal built on a guess is worse than no refusal at all.
    if ("symbol".equals(type)) {
      String length = attrs.getOrDefault("length", "").trim();
      boolean plain =
          attrs.getOrDefault("alphabet", "").isEmpty()
              && attrs.getOrDefault("include", "").isEmpty()
              && attrs.getOrDefault("exclude", "").isEmpty()
              && (length.isEmpty() || "1".equals(length));
      if (!plain) {
        return null;
      }
      try {
        return new java.util.LinkedHashSet<>(CharSet.parse(value)).size();
      } catch (RuntimeException e) {
        return null; // A malformed set is the charset error, not this one.
      }
    }

    if ("number".equals(type)) {
      int dots = value.indexOf("..");
      if (dots < 0 || !attrs.getOrDefault("decimals", "").trim().isEmpty()) {
        return null;
      }
      try {
        // Only whole-number ranges have a countable pool.
        long lo = Long.parseLong(value.substring(0, dots).trim());
        long hi = Long.parseLong(value.substring(dots + 2).trim());
        return hi >= lo ? (int) (hi - lo + 1) : null;
      } catch (NumberFormatException e) {
        return null;
      }
    }

    return null;
  }
}
