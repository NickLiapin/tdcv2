package io.github.nickliapin.tdc.parser;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Paired raw text, rewritten before the lexer ever sees it.
 *
 * <p>{@code <data pair="X">…</data pair="X">} lets a body carry a literal {@code </data>} — a
 * snippet of TDC syntax inside generated documentation, say. The grammar keeps one static {@code
 * </data>} close token because a lexer that had to know which closer belongs to which opener would
 * need the pair value inside a token rule, so the pairing is resolved here instead: the paired
 * closer becomes a plain {@code </data>} and every literal {@code </data>} in the body becomes a
 * sentinel the lexer reads as ordinary text. {@link #restore} puts the sentinel back when a body is
 * read.
 *
 * <p>The rewrite is length-preserving on purpose. Everything the lexer, the parser and the
 * validator report afterwards carries a line and a column, and those have to point into the file
 * the user wrote rather than into the one this pass produced — which is why the closing tag's
 * leftover characters become spaces instead of disappearing.
 *
 * <p>Ported from {@code typescript/src/parser/paired-data.ts}. The five implementations have to
 * agree character for character, malformed input included, so this follows the reference's
 * decisions even where a fresh design would choose otherwise.
 */
public final class PairedData {

  /**
   * NUL, which cannot appear in a hand-written config, standing in for the two ends of a literal
   * {@code </data>} while the lexer runs.
   */
  private static final char GUARD = '\0';

  /**
   * What a literal {@code </data>} inside a paired body becomes for the duration of lexing. Exactly
   * as long as the text it stands in for, which is what keeps every later position honest.
   */
  private static final String SENTINEL = GUARD + "/data" + GUARD;

  private static final String OPEN = "<data";
  private static final String CLOSE = "</data>";
  private static final String CLOSE_PREFIX = "</data";

  private PairedData() {}

  /** One paired tag that does not line up, at the position a user can act on. */
  public record Problem(int line, int column, String message) {}

  /** The source to lex, and everything wrong with the paired tags in it. */
  public record Rewrite(String source, List<Problem> problems) {}

  /** A close tag, and the {@code pair} it carried if it carried one. */
  private record Close(int start, int end, String pair) {}

  /** What the search for an opener's closer turned up: at most one of the two is present. */
  private record CloseSearch(Close match, Close mismatch) {}

  /** A line (1-based) and column (0-based), counted the way every diagnostic here is. */
  private record Position(int line, int column) {}

  public static Rewrite preprocess(String source) {
    StringBuilder out = new StringBuilder();
    int cursor = 0;
    List<Problem> problems = new ArrayList<>();
    Map<String, Position> seen = new HashMap<>();

    while (cursor < source.length()) {
      int openStart = source.indexOf(OPEN, cursor);
      if (openStart < 0) {
        out.append(source, cursor, source.length());
        break;
      }

      if (!isDataOpenAt(source, openStart)) {
        // `<database>` and friends: emit the false start and keep looking past it.
        out.append(source, cursor, openStart + OPEN.length());
        cursor = openStart + OPEN.length();
        continue;
      }

      int openEnd = findTagEnd(source, openStart);
      if (openEnd < 0) {
        out.append(source, cursor, source.length());
        break;
      }

      String openText = source.substring(openStart, openEnd + 1);
      String pair = pairValue(openText);
      if (pair == null || isSelfClosing(openText)) {
        out.append(source, cursor, openEnd + 1);
        cursor = openEnd + 1;
        continue;
      }

      Position pairPosition = position(source, openStart + openText.indexOf(pair));
      Position previous = seen.get(pair);
      if (previous != null) {
        problems.add(
            new Problem(
                pairPosition.line(),
                pairPosition.column(),
                "duplicate <data pair=\""
                    + pair
                    + "\"> value. First use was at line "
                    + previous.line()
                    + ", column "
                    + previous.column()
                    + "."));
      } else {
        seen.put(pair, pairPosition);
      }

      int bodyStart = openEnd + 1;
      CloseSearch search = findClose(source, bodyStart, pair);
      if (search.match() == null) {
        Close mismatch = search.mismatch();
        Position at = position(source, mismatch == null ? openStart : mismatch.start());
        String message =
            mismatch == null
                ? "unclosed <data pair=\"" + pair + "\">"
                : "expected </data pair=\""
                    + pair
                    + "\">, got </data pair=\""
                    + mismatch.pair()
                    + "\">";
        problems.add(new Problem(at.line(), at.column(), message));
        // Nothing after an unmatched opener can be rewritten with any confidence about where the
        // body was meant to end, so the rest of the file is handed over untouched.
        out.append(source, cursor, source.length());
        break;
      }

      Close match = search.match();
      out.append(source, cursor, bodyStart);
      out.append(source.substring(bodyStart, match.start()).replace(CLOSE, SENTINEL));
      out.append(CLOSE);
      out.append(
          structuralWhitespace(source.substring(match.start() + CLOSE.length(), match.end() + 1)));
      cursor = match.end() + 1;
    }

    return new Rewrite(out.toString(), List.copyOf(problems));
  }

  /** A {@code <data>} body as the user wrote it, with the sentinel back to a literal close tag. */
  public static String restore(String text) {
    return text.replace(SENTINEL, CLOSE);
  }

  private static boolean isDataOpenAt(String source, int index) {
    int after = index + OPEN.length();
    if (after >= source.length()) {
      return true;
    }
    char next = source.charAt(after);
    return next == '>' || next == '/' || isSpace(next);
  }

  private static boolean isSelfClosing(String tagText) {
    int at = tagText.length() - 2; // The tag always ends in '>'; read back from there.
    while (at >= 0 && isSpace(tagText.charAt(at))) {
      at--;
    }
    return at >= 0 && tagText.charAt(at) == '/';
  }

  /**
   * The close that pairs with {@code expected}, or — when there is none — the first close that
   * carried some other pair, which is the difference between "you closed it wrong" and "you never
   * closed it".
   */
  private static CloseSearch findClose(String source, int start, String expected) {
    int searchAt = start;
    Close mismatch = null;

    while (searchAt < source.length()) {
      int closeStart = source.indexOf(CLOSE_PREFIX, searchAt);
      if (closeStart < 0) {
        break;
      }
      int closeEnd = findTagEnd(source, closeStart);
      if (closeEnd < 0) {
        break;
      }

      String closePair = pairValue(source.substring(closeStart, closeEnd + 1));
      if (expected.equals(closePair)) {
        return new CloseSearch(new Close(closeStart, closeEnd, closePair), mismatch);
      }
      if (closePair != null && mismatch == null) {
        mismatch = new Close(closeStart, closeEnd, closePair);
      }
      searchAt = closeStart + CLOSE_PREFIX.length();
    }

    return new CloseSearch(null, mismatch);
  }

  /** The '>' that ends a tag, ignoring any inside quotes so {@code if="a>b"} does not end it. */
  private static int findTagEnd(String source, int start) {
    char quote = 0;
    for (int at = start; at < source.length(); at++) {
      char ch = source.charAt(at);
      if (quote != 0) {
        if (ch == quote) {
          quote = 0;
        }
        continue;
      }
      if (ch == '"' || ch == '\'') {
        quote = ch;
        continue;
      }
      if (ch == '>') {
        return at;
      }
    }
    return -1;
  }

  /** The {@code pair="…"} value in a tag, as the reference's {@code \bpair\s*=\s*"([^"\r\n]*)"} */
  private static String pairValue(String tagText) {
    int at = 0;
    while (true) {
      int found = tagText.indexOf("pair", at);
      if (found < 0) {
        return null;
      }
      // The word boundary: `superpair=` is not a pair attribute, `data-pair=` is.
      if (found > 0 && isWordChar(tagText.charAt(found - 1))) {
        at = found + 1;
        continue;
      }

      int scan = skipSpace(tagText, found + "pair".length());
      if (scan >= tagText.length() || tagText.charAt(scan) != '=') {
        at = found + 1;
        continue;
      }
      scan = skipSpace(tagText, scan + 1);
      if (scan >= tagText.length() || tagText.charAt(scan) != '"') {
        at = found + 1;
        continue;
      }

      scan++;
      int valueStart = scan;
      while (scan < tagText.length()) {
        char ch = tagText.charAt(scan);
        if (ch == '"' || ch == '\r' || ch == '\n') {
          break;
        }
        scan++;
      }
      if (scan < tagText.length() && tagText.charAt(scan) == '"') {
        return tagText.substring(valueStart, scan);
      }
      at = found + 1;
    }
  }

  private static int skipSpace(String text, int at) {
    while (at < text.length() && isSpace(text.charAt(at))) {
      at++;
    }
    return at;
  }

  /** Line breaks kept, everything else blanked — the closer's leftovers hold their place. */
  private static String structuralWhitespace(String text) {
    StringBuilder out = new StringBuilder();
    // By code point, not by char: an astral character in a pair value is one space in the
    // reference, and two would push every column after it out by one.
    text.codePoints().forEach(cp -> out.append(cp == '\n' || cp == '\r' ? (char) cp : ' '));
    return out.toString();
  }

  private static Position position(String source, int index) {
    int line = 1;
    int column = 0;
    for (int at = 0; at < index; at++) {
      if (source.charAt(at) == '\n') {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
    return new Position(line, column);
  }

  /**
   * Whitespace as JavaScript's {@code \s} defines it, which is what the reference tests against.
   * Spelling the set out is what stops five languages disagreeing over an exotic space: {@link
   * Character#isWhitespace} excludes U+00A0 and admits the ASCII file separators, so it is not this
   * set under another name.
   */
  private static boolean isSpace(char ch) {
    return ch == '\t'
        || ch == '\n'
        || ch == 0x000B
        || ch == '\f'
        || ch == '\r'
        || ch == ' '
        || ch == 0x00A0
        || ch == 0x1680
        || (ch >= 0x2000 && ch <= 0x200A)
        || ch == 0x2028
        || ch == 0x2029
        || ch == 0x202F
        || ch == 0x205F
        || ch == 0x3000
        || ch == 0xFEFF;
  }

  private static boolean isWordChar(char ch) {
    return (ch >= 'a' && ch <= 'z')
        || (ch >= 'A' && ch <= 'Z')
        || (ch >= '0' && ch <= '9')
        || ch == '_';
  }
}
