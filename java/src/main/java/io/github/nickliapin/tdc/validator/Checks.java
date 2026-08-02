package io.github.nickliapin.tdc.validator;

import io.github.nickliapin.tdc.date.DateLocales;
import io.github.nickliapin.tdc.format.Transforms;
import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.generators.NumberGen;
import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.unicode.Alphabets;
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
}
