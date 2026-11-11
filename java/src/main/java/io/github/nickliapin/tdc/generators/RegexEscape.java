package io.github.nickliapin.tdc.generators;

import java.util.function.Function;
import java.util.function.Supplier;

/**
 * What a backslash means once the classes ({@code \d}, {@code \w}, {@code \s}, …) are out of the
 * way.
 *
 * <p>Shared by {@code regex} and {@code advanced_regex} — the port of the reference's {@code
 * regex-escape.ts}. Until it, every other escape fell to one {@code default} arm that returned the
 * escaped character, so backslash-x41 printed {@code x41} and a word boundary around {@code INV-}
 * printed a literal {@code b} on each side, after a clean check.
 *
 * <ul>
 *   <li>backslash-x HH, backslash-u HHHH — the character with that code
 *   <li>{@code \b \B \A \Z \z \G} — refused: a generated value has nothing around it to assert
 *   <li>any other ASCII letter — refused: never the letter itself
 * </ul>
 *
 * <p>Punctuation stays the character, as it always was.
 */
final class RegexEscape {
  private RegexEscape() {}

  /** The literal an escape stands for, or a refusal naming why it cannot be one. */
  static String escapedLiteral(String ch, Function<String, RuntimeException> fail) {
    if (ch.length() == 1 && "bBAZzG".indexOf(ch.charAt(0)) >= 0) {
      throw fail.apply(
          "\"\\" + ch + "\" is a zero-width assertion, and a generated value has nothing around it"
              + " to assert — remove it");
    }
    if (ch.length() == 1
        && ((ch.charAt(0) >= 'a' && ch.charAt(0) <= 'z')
            || (ch.charAt(0) >= 'A' && ch.charAt(0) <= 'Z'))) {
      throw fail.apply(
          "unknown escape \"\\" + ch + "\" — write the letter without the backslash, or \\xHH or"
              + " \\uHHHH for a character by its code");
    }
    return ch;
  }

  /** Backslash-x HH or backslash-u HHHH, the {@code x} or {@code u} already read. */
  static String hexEscape(
      String kind, Supplier<String> next, Function<String, RuntimeException> fail) {
    int digits = "x".equals(kind) ? 2 : 4;
    StringBuilder hex = new StringBuilder();
    for (int i = 0; i < digits; i++) {
      String c = next.get();
      if (c == null || c.length() != 1 || Character.digit(c.charAt(0), 16) < 0) {
        throw fail.apply(
            "\"\\" + kind + "\" needs exactly " + digits + " hex digits, as in "
                + ("x".equals(kind) ? "\\x41" : "\\u0410"));
      }
      hex.append(c);
    }
    int code = Integer.parseInt(hex.toString(), 16);
    if (code >= 0xD800 && code <= 0xDFFF) {
      throw fail.apply("\"\\u" + hex + "\" is half of a surrogate pair — write the character itself");
    }
    return new String(Character.toChars(code));
  }
}
