package io.github.nickliapin.tdc.expr;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The tiny expression language behind {@code if="..."}.
 *
 * <p>Comparison ({@code == != < > <= >=}), logic ({@code && || !}) and arithmetic ({@code + - *
 * /}) over sequence values, numbers and quoted strings.
 *
 * <p>The reference parses these with jsep, a JavaScript expression parser, so the precedence
 * table below is jsep's rather than one chosen here. Reproducing it matters: an expression like
 * {@code a == b && c} has to bind the same way in both implementations or the two engines
 * disagree about which rows appear, which is the kind of difference no test of a single value
 * would catch.
 *
 * <p>A bare word that names no sequence is its own value: {@code Gender == Male} works without
 * quoting "Male", which is how configs have always been written.
 */
public sealed interface Expr {

  record Num(double value) implements Expr {}

  record Str(String value) implements Expr {}

  record Bool(boolean value) implements Expr {}

  record Null() implements Expr {}

  record Name(String value) implements Expr {}

  /** A dotted reference: a compound field, a value test, or a literal — resolved at evaluation. */
  record Member(String dotted) implements Expr {}

  record Binary(String op, Expr left, Expr right) implements Expr {}

  record Unary(String op, Expr operand) implements Expr {}

  /**
   * {@code x[0]} — subscripting, which the evaluator does not implement.
   *
   * <p>Parsed rather than rejected so the complaint can name what is unsupported. A parser
   * stricter than the reference's turns "computed member access is not supported" into "syntax
   * error", and the second says nothing about what to write instead.
   */
  record Computed(Expr object) implements Expr {}

  /** jsep's binary precedence, verbatim. Higher binds tighter. */
  Map<String, Integer> PRECEDENCE =
      Map.ofEntries(
          Map.entry("||", 1),
          Map.entry("&&", 2),
          Map.entry("==", 6),
          Map.entry("!=", 6),
          Map.entry("===", 6),
          Map.entry("!==", 6),
          Map.entry("<", 7),
          Map.entry(">", 7),
          Map.entry("<=", 7),
          Map.entry(">=", 7),
          Map.entry("+", 9),
          Map.entry("-", 9),
          Map.entry("*", 10),
          Map.entry("/", 10),
          Map.entry("%", 10));

  /**
   * A hard ceiling on parenthesis nesting. The parser recurses per '(', so a generated
   * "((((...))))" is a stack overflow for the price of a text file. Real expressions nest a
   * handful. The scan is linear and quote-aware; the same ceiling lives in every implementation.
   */
  static final int MAX_EXPR_NESTING = 32;

  private static int parenDepth(String source) {
    int depth = 0;
    int deepest = 0;
    char inString = 0;
    boolean escaped = false;
    for (int i = 0; i < source.length(); i++) {
      char ch = source.charAt(i);
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString != 0) {
        if (ch == '\\') {
          escaped = true;
        } else if (ch == inString) {
          inString = 0;
        }
        continue;
      }
      if (ch == '\'' || ch == '"') {
        inString = ch;
      } else if (ch == '(' || ch == '[') {
        depth++;
        deepest = Math.max(deepest, depth);
      } else if (ch == ')' || ch == ']') {
        depth = Math.max(0, depth - 1);
      }
    }
    return deepest;
  }

  static Expr parse(String source) {
    if (parenDepth(source) > MAX_EXPR_NESTING) {
      throw new IllegalArgumentException(
          "nests deeper than " + MAX_EXPR_NESTING + " levels");
    }
    Parser parser = new Parser(source);
    Expr result = parser.expression(0);
    parser.skipSpace();
    if (!parser.done()) {
      throw new IllegalArgumentException(
          "if expression: unexpected \"" + parser.rest() + "\" in \"" + source + "\"");
    }
    return result;
  }

  /** Precedence climbing over a hand-written tokenizer. */
  final class Parser {
    private final String src;
    private int pos;

    Parser(String src) {
      this.src = src;
    }

    boolean done() {
      return pos >= src.length();
    }

    String rest() {
      return src.substring(pos);
    }

    void skipSpace() {
      while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
        pos++;
      }
    }

    Expr expression(int minPrecedence) {
      Expr left = unary();
      while (true) {
        skipSpace();
        String op = peekOperator();
        if (op == null) {
          return left;
        }
        int precedence = PRECEDENCE.get(op);
        if (precedence < minPrecedence) {
          return left;
        }
        pos += op.length();
        // Left-associative: the right operand stops at anything this loop can handle itself.
        Expr right = expression(precedence + 1);
        left = new Binary(op, left, right);
      }
    }

    private Expr unary() {
      skipSpace();
      if (pos < src.length()) {
        char c = src.charAt(pos);
        if (c == '!' && !src.startsWith("!=", pos)) {
          pos++;
          return new Unary("!", unary());
        }
        if ((c == '-' || c == '+') && !isNumberStart()) {
          pos++;
          return new Unary(String.valueOf(c), unary());
        }
        // `~` parses and then fails validation, rather than failing to parse. The reference's
        // expression library accepts it too, and both have to refuse the same configs for the
        // same stated reason — "unsupported operator" says more than "syntax error" does.
        if (c == '~') {
          pos++;
          return new Unary("~", unary());
        }
      }
      return primary();
    }

    /** A leading {@code -} belongs to the number when a digit follows it directly. */
    private boolean isNumberStart() {
      return pos + 1 < src.length() && Character.isDigit(src.charAt(pos + 1));
    }

    private Expr primary() {
      skipSpace();
      if (done()) {
        throw new IllegalArgumentException("if expression: ends where a value was expected");
      }
      char c = src.charAt(pos);

      if (c == '(') {
        pos++;
        Expr inner = expression(0);
        skipSpace();
        if (done() || src.charAt(pos) != ')') {
          throw new IllegalArgumentException("if expression: unbalanced parentheses in \"" + src + "\"");
        }
        pos++;
        return inner;
      }

      if (c == '\'' || c == '"') {
        return string(c);
      }

      if (Character.isDigit(c) || (c == '-' && isNumberStart())) {
        return number();
      }

      if (Character.isLetter(c) || c == '_' || c == '$') {
        Expr value = word();
        // A subscript parses and then fails validation, so the complaint can say which
        // construct is unsupported rather than only where the parser stopped.
        skipSpace();
        while (!done() && src.charAt(pos) == '[') {
          pos++;
          expression(0);
          skipSpace();
          if (done() || src.charAt(pos) != ']') {
            throw new IllegalArgumentException(
                "if expression: unbalanced brackets in \"" + src + "\"");
          }
          pos++;
          skipSpace();
          value = new Computed(value);
        }
        return value;
      }

      throw new IllegalArgumentException(
          "if expression: cannot read \"" + src.substring(pos) + "\" in \"" + src + "\"");
    }

    private Expr string(char quote) {
      pos++;
      StringBuilder out = new StringBuilder();
      while (pos < src.length() && src.charAt(pos) != quote) {
        char c = src.charAt(pos);
        if (c == '\\' && pos + 1 < src.length()) {
          pos++;
          c = src.charAt(pos);
        }
        out.append(c);
        pos++;
      }
      if (done()) {
        throw new IllegalArgumentException("if expression: unterminated string in \"" + src + "\"");
      }
      pos++;
      return new Str(out.toString());
    }

    private Expr number() {
      int start = pos;
      if (src.charAt(pos) == '-') {
        pos++;
      }
      while (pos < src.length() && (Character.isDigit(src.charAt(pos)) || src.charAt(pos) == '.')) {
        pos++;
      }
      return new Num(Double.parseDouble(src.substring(start, pos)));
    }

    private Expr word() {
      List<String> parts = new ArrayList<>();
      parts.add(identifier());
      while (pos < src.length() && src.charAt(pos) == '.') {
        pos++;
        parts.add(identifier());
      }
      if (parts.size() == 1) {
        String name = parts.get(0);
        return switch (name) {
          case "true" -> new Bool(true);
          case "false" -> new Bool(false);
          case "null" -> new Null();
          default -> new Name(name);
        };
      }
      return new Member(String.join(".", parts));
    }

    private String identifier() {
      int start = pos;
      while (pos < src.length()) {
        char c = src.charAt(pos);
        if (Character.isLetterOrDigit(c) || c == '_' || c == '$') {
          pos++;
        } else {
          break;
        }
      }
      if (start == pos) {
        throw new IllegalArgumentException("if expression: expected a name in \"" + src + "\"");
      }
      return src.substring(start, pos);
    }

    private String peekOperator() {
      // Longest first, so `<=` is never read as `<` followed by a stray `=`.
      for (String op :
          List.of("===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/",
              "%")) {
        if (src.startsWith(op, pos)) {
          return op;
        }
      }
      return null;
    }
  }
}
