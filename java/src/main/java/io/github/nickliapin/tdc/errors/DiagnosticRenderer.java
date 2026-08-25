package io.github.nickliapin.tdc.errors;

import java.util.ArrayList;
import java.util.List;

/**
 * Diagnostics, printed the way a compiler prints them.
 *
 * <p>A header carrying severity and code, a {@code -->} line naming the position, the offending
 * source line with a caret under it, and the hint as a {@code note}. The point is that one block
 * pasted into a chat or an issue is actionable on its own — nobody has to also send the config.
 *
 * <p>Ported from {@code typescript/src/errors/format.ts} and held to it by {@code
 * fixtures/cross-language/cli.json}: a user who runs the same broken config through two
 * implementations should see the same complaint, not two dialects of it.
 *
 * <pre>
 * error[TDC071]: unknown template path "nosuch.path"
 *  --&gt; demo.tdc:3:57
 *   |
 * 3 |     &lt;sequence name="N"&gt;&lt;gen type="template" value="nosuch.path"/&gt;&lt;/sequence&gt;
 *   |                                                         ^
 *   |
 * note: check the pack name
 * </pre>
 */
public final class DiagnosticRenderer {

  private DiagnosticRenderer() {}

  private static final String RED = "\033[31m";
  private static final String YELLOW = "\033[33m";
  private static final String CYAN = "\033[36m";
  private static final String BOLD = "\033[1m";
  private static final String RESET = "\033[0m";

  private static String colorize(String text, String code, boolean enabled) {
    return enabled ? code + text + RESET : text;
  }

  /** One diagnostic as a block. Without {@code source} only the header and position are printed. */
  public static String format(
      Diagnostic diagnostic, String source, String filename, boolean colors) {
    String severityColor = diagnostic.severity() == Diagnostic.Severity.ERROR ? RED : YELLOW;
    String label =
        colorize(
            colorize(diagnostic.severity().toString(), severityColor, colors)
                + (diagnostic.code() == null || diagnostic.code().isEmpty()
                    ? ""
                    : "[" + diagnostic.code() + "]"),
            BOLD,
            colors);

    List<String> lines = new ArrayList<>();
    lines.add(label + ": " + diagnostic.message());
    // The column is held 0-based, as the shared fixtures record it, and printed 1-based, as every
    // editor counts.
    lines.add(" --> " + filename + ":" + diagnostic.line() + ":" + (diagnostic.column() + 1));

    if (source != null && !source.isEmpty()) {
      lines.addAll(snippet(diagnostic, source, colors));
    }
    // `help` before `note`, as the reference prints them: the near name first, the explanation
    // after it.
    if (diagnostic.suggestion() != null && !diagnostic.suggestion().isEmpty()) {
      lines.add(colorize("help", CYAN, colors) + ": " + diagnostic.suggestion());
    }
    if (diagnostic.hint() != null && !diagnostic.hint().isEmpty()) {
      lines.add(colorize("note", CYAN, colors) + ": " + diagnostic.hint());
    }
    return String.join("\n", lines);
  }

  /** Every diagnostic as a block, with a count at the end. Empty input gives an empty string. */
  public static String formatAll(
      List<Diagnostic> diagnostics, String source, String filename, boolean colors) {
    if (diagnostics.isEmpty()) {
      return "";
    }

    List<String> blocks = new ArrayList<>();
    for (Diagnostic diagnostic : diagnostics) {
      blocks.add(format(diagnostic, source, filename, colors));
    }

    int errors = 0;
    for (Diagnostic diagnostic : diagnostics) {
      if (diagnostic.severity() == Diagnostic.Severity.ERROR) {
        errors++;
      }
    }
    int warnings = diagnostics.size() - errors;

    List<String> parts = new ArrayList<>();
    if (errors > 0) {
      parts.add(errors + " error" + (errors == 1 ? "" : "s"));
    }
    if (warnings > 0) {
      parts.add(warnings + " warning" + (warnings == 1 ? "" : "s"));
    }

    blocks.add("");
    // "aborted" only when something actually stopped. Warnings alone leave a run that finished,
    // and announcing it as aborted sends the reader looking for a failure that never happened.
    String line = errors > 0
        ? "aborted: " + String.join(", ", parts)
        : String.join(", ", parts);
    blocks.add(colorize(line, BOLD, colors));
    return String.join("\n\n", blocks);
  }

  /** The offending line, with a caret under the column. Nothing when the line is out of range. */
  private static List<String> snippet(Diagnostic diagnostic, String source, boolean colors) {
    String[] sourceLines = source.split("\n", -1);
    int index = diagnostic.line() - 1;
    if (index < 0 || index >= sourceLines.length) {
      return List.of();
    }
    String text = sourceLines[index];

    String number = String.valueOf(diagnostic.line());
    String blank = " ".repeat(number.length());
    String pipe = colorize("|", CYAN, colors);
    int column = Math.max(0, diagnostic.column());
    int caretLen = underline(text, column);

    // Window an over-long line around the carets, marking cut edges with "…".
    // The same formula lives in the other four implementations' renderers.
    String shown = text;
    int caretStart = column;
    if (text.length() > SNIPPET_WINDOW) {
      int start = Math.max(0, Math.min(column - 40, text.length() - SNIPPET_WINDOW));
      int end = start + SNIPPET_WINDOW;
      String prefix = start > 0 ? "\u2026" : "";
      String suffix = end < text.length() ? "\u2026" : "";
      shown = prefix + text.substring(start, end) + suffix;
      caretLen = Math.max(1, Math.min(caretLen, end - column));
      caretStart = column - start + prefix.length();
    }

    String caret = " ".repeat(caretStart) + colorize("^".repeat(caretLen), RED, colors);

    return List.of(
        blank + " " + pipe,
        colorize(number, CYAN, colors) + " " + pipe + " " + shown,
        blank + " " + pipe + " " + caret,
        blank + " " + pipe);
  }

  /**
   * The widest source excerpt a snippet will show. A generated single-line config can be
   * arbitrarily long; echoing 100 KB of it (plus as many carets) buries the message it was meant
   * to illustrate.
   */
  private static final int SNIPPET_WINDOW = 160;

  /**
   * How many characters the carets cover: the whole of what is wrong, not its first letter.
   *
   * <p>Read back off the source line rather than carried on the diagnostic. A position points at
   * one of two things — an element, or a value inside its quotes — and both say where they end in
   * the text itself, so a hundred call sites do not each have to remember to pass a length they
   * would get wrong once and nobody would notice.
   *
   * <p>Every diagnostic in the shared fixtures underlines exactly what the reference underlines; a
   * position that is neither gets one caret, which is what it had before.
   */
  private static int underline(String text, int column) {
    if (column >= text.length()) {
      return 1;
    }

    // A tag: through its closing ">", or through the matching "</name>" when it has one. "<!--" is
    // not a tag, so a comment is not swallowed.
    boolean named =
        column + 1 < text.length() && isAsciiLetter(text.charAt(column + 1));
    if (text.charAt(column) == '<' && named) {
      int openEnd = tagEnd(text, column);
      if (openEnd < 0) {
        return text.length() - column;
      }
      if (text.charAt(openEnd - 1) == '/') {
        return openEnd + 1 - column;
      }
      int depth = 1;
      int k = openEnd + 1;
      while (k < text.length()) {
        if (text.charAt(k) != '<') {
          k++;
          continue;
        }
        if (k + 1 < text.length() && text.charAt(k + 1) == '/') {
          int closeEnd = text.indexOf('>', k);
          if (closeEnd < 0) {
            break;
          }
          if (--depth == 0) {
            return closeEnd + 1 - column;
          }
          k = closeEnd + 1;
        } else {
          int end = tagEnd(text, k);
          if (end < 0) {
            break;
          }
          if (text.charAt(end - 1) != '/') {
            depth++;
          }
          k = end + 1;
        }
      }
      return text.length() - column;
    }

    // Otherwise a value: up to the quote that closes it. An empty one puts the position on that
    // quote already, and underlines the one character.
    int close = text.indexOf('"', column);
    return close > column ? close - column : 1;
  }

  private static boolean isAsciiLetter(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }

  /**
   * The {@code >} that closes the tag opening at {@code at} — a {@code >} inside an attribute value
   * ends nothing.
   */
  private static int tagEnd(String text, int at) {
    char quote = 0;
    for (int i = at + 1; i < text.length(); i++) {
      char c = text.charAt(i);
      if (quote != 0) {
        if (c == quote) {
          quote = 0;
        }
      } else if (c == '"' || c == '\'') {
        quote = c;
      } else if (c == '>') {
        return i;
      }
    }
    return -1;
  }
}
