package io.github.nickliapin.tdc.compute;

/**
 * {@code <encode as="...">} — one character to a number.
 *
 * <p>The step every alphanumeric check digit needs: an IBAN turns letters into numbers before it
 * takes its mod 97, a vehicle identification number folds letters into digits before weighting.
 *
 * <p>For {@code base36}, {@code ascii} and {@code unicode} the result is the character's
 * <em>decimal</em> value, so {@code A} under base36 is the string {@code "10"} and a fold then
 * consumes those digits. For {@code hex}, {@code binary} and {@code octal} it is the code point
 * written in that base.
 *
 * <p>A character means one Unicode code point, never one UTF-16 unit — the rest of the layer
 * iterates strings by code point, and an encoding that disagreed would split an emoji in half.
 */
public final class Encode {

  private Encode() {}

  public static String encodeChar(String ch, String as) {
    return switch (as) {
      case "base36" -> String.valueOf(base36Value(ch));
      case "ascii" -> {
        int cp = codePointOf(ch);
        if (cp >= 128) {
          throw new ComputeError(
              "<encode as=\"ascii\">: \"" + ch + "\" is not an ASCII character (code >= 128)");
        }
        yield String.valueOf(cp);
      }
      case "unicode" -> String.valueOf(codePointOf(ch));
      case "hex" -> Integer.toString(codePointOf(ch), 16);
      case "binary" -> Integer.toString(codePointOf(ch), 2);
      case "octal" -> Integer.toString(codePointOf(ch), 8);
      default -> throw new ComputeError(
          "<encode as=\"" + as + "\">: unknown encoding (base36, ascii, unicode, hex, binary, octal)");
    };
  }

  static int codePointOf(String ch) {
    if (ch.codePointCount(0, ch.length()) != 1) {
      throw new ComputeError("<encode>: expected a single character, got \"" + ch + "\"");
    }
    return ch.codePointAt(0);
  }

  /** 0-9 to 0..9, and either case of A-Z to 10..35. */
  private static int base36Value(String ch) {
    int cp = codePointOf(ch);
    if (cp >= '0' && cp <= '9') {
      return cp - '0';
    }
    if (cp >= 'A' && cp <= 'Z') {
      return cp - 'A' + 10;
    }
    if (cp >= 'a' && cp <= 'z') {
      return cp - 'a' + 10;
    }
    throw new ComputeError("<encode as=\"base36\">: \"" + ch + "\" is not a digit or letter");
  }
}
