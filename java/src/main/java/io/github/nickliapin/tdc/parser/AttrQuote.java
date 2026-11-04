package io.github.nickliapin.tdc.parser;

/**
 * An attribute value as the lexer hands it over — quotes included — and the text between them.
 *
 * <p>A value is quoted with {@code "} or with {@code '} and closes with the quote it opened with.
 * Nothing inside is escaped, so the other kind of quote is how a value holds one: {@code
 * value='say "hi"'}.
 */
public final class AttrQuote {

  private AttrQuote() {}

  /** Whether {@code text} is a whole quoted value, either kind of quote. */
  public static boolean isQuoted(String text) {
    if (text.length() < 2) {
      return false;
    }
    char open = text.charAt(0);
    return (open == '"' || open == '\'') && text.charAt(text.length() - 1) == open;
  }

  /** The text between the quotes, or {@code text} itself when it is not quoted. */
  public static String unquote(String text) {
    return isQuoted(text) ? text.substring(1, text.length() - 1) : text;
  }
}
