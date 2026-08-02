package io.github.nickliapin.tdc.packs;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small, strict JSON reader — enough to read a config file, and no more.
 *
 * <p>Written rather than depended on for the same reason the Parquet writer is: this library
 * ships with no runtime dependencies, and one added to read a twenty-line settings file would be
 * a poor trade. Strict on purpose — a file the reference rejects has to be rejected here too, or
 * the two disagree about which projects are configured correctly.
 */
public final class Json {

  /** Anything malformed, reported with where it went wrong. */
  public static final class SyntaxException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    SyntaxException(String message) {
      super(message);
    }
  }

  private final String text;
  private int at;

  private Json(String text) {
    this.text = text;
  }

  /**
   * Parse a document.
   *
   * @return a {@code Map}, {@code List}, {@code String}, {@code Double}, {@code Boolean}, or
   *     {@code null}
   */
  public static Object parse(String text) {
    Json reader = new Json(text);
    reader.skipSpace();
    Object value = reader.value();
    reader.skipSpace();
    if (reader.at < reader.text.length()) {
      throw new SyntaxException("unexpected trailing text at position " + reader.at);
    }
    return value;
  }

  private Object value() {
    if (at >= text.length()) {
      throw new SyntaxException("unexpected end of input");
    }
    char c = text.charAt(at);
    switch (c) {
      case '{':
        return object();
      case '[':
        return array();
      case '"':
        return string();
      case 't':
        return literal("true", Boolean.TRUE);
      case 'f':
        return literal("false", Boolean.FALSE);
      case 'n':
        return literal("null", null);
      default:
        return number();
    }
  }

  private Map<String, Object> object() {
    Map<String, Object> out = new LinkedHashMap<>();
    at++; // '{'
    skipSpace();
    if (peek() == '}') {
      at++;
      return out;
    }
    while (true) {
      skipSpace();
      if (peek() != '"') {
        throw new SyntaxException("expected a key at position " + at);
      }
      String key = string();
      skipSpace();
      expect(':');
      skipSpace();
      out.put(key, value());
      skipSpace();
      char c = next();
      if (c == '}') {
        return out;
      }
      if (c != ',') {
        throw new SyntaxException("expected ',' or '}' at position " + (at - 1));
      }
    }
  }

  private List<Object> array() {
    List<Object> out = new ArrayList<>();
    at++; // '['
    skipSpace();
    if (peek() == ']') {
      at++;
      return out;
    }
    while (true) {
      skipSpace();
      out.add(value());
      skipSpace();
      char c = next();
      if (c == ']') {
        return out;
      }
      if (c != ',') {
        throw new SyntaxException("expected ',' or ']' at position " + (at - 1));
      }
    }
  }

  private String string() {
    at++; // opening quote
    StringBuilder out = new StringBuilder();
    while (true) {
      if (at >= text.length()) {
        throw new SyntaxException("unterminated string");
      }
      char c = text.charAt(at++);
      if (c == '"') {
        return out.toString();
      }
      if (c != '\\') {
        out.append(c);
        continue;
      }
      char escape = next();
      switch (escape) {
        case '"' -> out.append('"');
        case '\\' -> out.append('\\');
        case '/' -> out.append('/');
        case 'b' -> out.append('\b');
        case 'f' -> out.append('\f');
        case 'n' -> out.append('\n');
        case 'r' -> out.append('\r');
        case 't' -> out.append('\t');
        case 'u' -> {
          if (at + 4 > text.length()) {
            throw new SyntaxException("truncated \\u escape");
          }
          out.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
          at += 4;
        }
        default -> throw new SyntaxException("unknown escape \\" + escape);
      }
    }
  }

  private Double number() {
    int start = at;
    if (peek() == '-') {
      at++;
    }
    while (at < text.length() && "0123456789.eE+-".indexOf(text.charAt(at)) >= 0) {
      at++;
    }
    if (start == at) {
      throw new SyntaxException("unexpected character '" + text.charAt(at) + "' at position " + at);
    }
    try {
      return Double.valueOf(text.substring(start, at));
    } catch (NumberFormatException e) {
      throw new SyntaxException("not a number: \"" + text.substring(start, at) + "\"");
    }
  }

  private Object literal(String word, Object value) {
    if (!text.startsWith(word, at)) {
      throw new SyntaxException("unexpected value at position " + at);
    }
    at += word.length();
    return value;
  }

  private void skipSpace() {
    while (at < text.length() && Character.isWhitespace(text.charAt(at))) {
      at++;
    }
  }

  private char peek() {
    if (at >= text.length()) {
      throw new SyntaxException("unexpected end of input");
    }
    return text.charAt(at);
  }

  private char next() {
    char c = peek();
    at++;
    return c;
  }

  private void expect(char c) {
    if (next() != c) {
      throw new SyntaxException("expected '" + c + "' at position " + (at - 1));
    }
  }
}
