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

  /**
   * A literal written as a whole number, kept as one.
   *
   * <p>Forcing it to double at parse time would lose the argument before anything could protect
   * it: 9007199254740993 becomes 9007199254740992, and no later care puts the digit back.
   */
  record Int(long value) implements Expr {}

  record Str(String value) implements Expr {}

  record Bool(boolean value) implements Expr {}

  record Null() implements Expr {}

  record Name(String value) implements Expr {}

  /** A dotted reference: a compound field, a value test, or a literal — resolved at evaluation. */
  record Member(String dotted) implements Expr {}

  record Binary(String op, Expr left, Expr right) implements Expr {}

  record Unary(String op, Expr operand) implements Expr {}

  /** {@code abs(x)} — a call on a bare name, with its arguments already parsed. */
  record Call(String callee, java.util.List<Expr> args) implements Expr {}

  /** {@code [US, CA, MX]} — only ever the right side of {@code in}. */
  record Arr(java.util.List<Expr> items) implements Expr {}

  /** {@code a ? b : c} — picks a VALUE, which is then compared like any other. */
  record Conditional(Expr test, Expr consequent, Expr alternate) implements Expr {}

  /**
   * {@code x[0]} — subscripting, which the evaluator does not implement.
   *
   * <p>Parsed rather than rejected so the complaint can name what is unsupported. A parser
   * stricter than the reference's turns "computed member access is not supported" into "syntax
   * error", and the second says nothing about what to write instead.
   */
  record Computed(Expr object) implements Expr {}

  /**
   * jsep's binary precedence, verbatim. Higher binds tighter.
   *
   * <p>The bitwise and shift operators are here even though the engine implements none of them,
   * and that is the point: the reference parses whatever jsep parses and then refuses the operator
   * BY NAME. A table that stopped at the supported set answered {@code x & 1} with a syntax error
   * pointing at the ampersand, which tells the reader nothing about what to write instead.
   */
  Map<String, Integer> PRECEDENCE =
      Map.ofEntries(
          Map.entry("||", 1),
          Map.entry("&&", 2),
          Map.entry("|", 3),
          Map.entry("^", 4),
          Map.entry("&", 5),
          Map.entry("<<", 8),
          Map.entry(">>", 8),
          Map.entry(">>>", 8),
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
          Map.entry("%", 10),
          // A word operator rather than a symbol; peekOperator keeps it from
          // swallowing a sequence called "index".
          Map.entry("in", 7));

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
    Expr result = parser.ternary(0);
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

    /**
     * {@code a ? b : c}, which binds looser than every binary operator.
     *
     * <p>Wrapping the binary loop rather than living inside it is what makes {@code x > 1 ? a : b}
     * read as {@code (x > 1) ? a : b} and not {@code x > (1 ? a : b)}.
     */
    Expr ternary(int minPrecedence) {
      Expr test = expression(minPrecedence);
      skipSpace();
      if (done() || src.charAt(pos) != '?') {
        return test;
      }
      pos++;
      Expr consequent = ternary(0);
      skipSpace();
      if (done() || src.charAt(pos) != ':') {
        throw new IllegalArgumentException(
            "if expression: a ? without its : in \"" + src + "\"");
      }
      pos++;
      return new Conditional(test, consequent, ternary(0));
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

    private static boolean isWordChar(char c) {
      return Character.isLetterOrDigit(c) || c == '_' || c == '$';
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

      if (c == '[') {
        pos++;
        List<Expr> items = new ArrayList<>();
        skipSpace();
        if (!done() && src.charAt(pos) == ']') {
          pos++;
          return new Arr(items);
        }
        while (true) {
          items.add(ternary(0));
          skipSpace();
          if (done()) {
            throw new IllegalArgumentException(
                "if expression: unbalanced brackets in \"" + src + "\"");
          }
          if (src.charAt(pos) == ',') {
            pos++;
            continue;
          }
          if (src.charAt(pos) == ']') {
            pos++;
            break;
          }
          throw new IllegalArgumentException(
              "if expression: unbalanced brackets in \"" + src + "\"");
        }
        return new Arr(items);
      }

      if (c == '(') {
        pos++;
        Expr inner = ternary(0);
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
        skipSpace();
        // A call, but only on a bare name: `abs(x)` and never `obj.method(x)`. The reference
        // restricts it the same way, and the validator says so with a position.
        if (value instanceof Name named && !done() && src.charAt(pos) == '(') {
          pos++;
          java.util.List<Expr> args = new java.util.ArrayList<>();
          skipSpace();
          if (!done() && src.charAt(pos) == ')') {
            pos++;
          } else {
            while (true) {
              args.add(ternary(0));
              skipSpace();
              if (done()) {
                throw new IllegalArgumentException(
                    "if expression: unbalanced parentheses in \"" + src + "\"");
              }
              if (src.charAt(pos) == ',') {
                pos++;
                continue;
              }
              if (src.charAt(pos) == ')') {
                pos++;
                break;
              }
              throw new IllegalArgumentException(
                  "if expression: unbalanced parentheses in \"" + src + "\"");
            }
          }
          skipSpace();
          return new Call(named.value(), args);
        }
        // A subscript parses and then fails validation, so the complaint can say which
        // construct is unsupported rather than only where the parser stopped.
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
      // An exponent is part of the number, not a name glued to it. Without this,
      // `1e200` lexed as the number 1 followed by the name `e200`, and the parser
      // reported "unbalanced parentheses" — a message about the wrong thing
      // entirely.
      if (pos < src.length() && (src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
        int after = pos + 1;
        if (after < src.length() && (src.charAt(after) == '+' || src.charAt(after) == '-')) {
          after++;
        }
        // Only take the "e" if a digit follows it; otherwise this is a name
        // sitting against a number and the caller should see it as one.
        if (after < src.length() && Character.isDigit(src.charAt(after))) {
          pos = after;
          while (pos < src.length() && Character.isDigit(src.charAt(pos))) {
            pos++;
          }
        }
      }
      String literal = src.substring(start, pos);
      // Digits and an optional sign, nothing else: a point or an exponent means
      // the author wrote a fraction and meant one.
      String body =
          !literal.isEmpty() && (literal.charAt(0) == '+' || literal.charAt(0) == '-')
              ? literal.substring(1)
              : literal;
      if (!body.isEmpty() && body.chars().allMatch(Character::isDigit)) {
        try {
          return new Int(Long.parseLong(literal));
        } catch (NumberFormatException outsideTheDomain) {
          // Wider than i64: fall through and let it be a double, which is the
          // only thing left that can hold it at all.
        }
      }
      return new Num(Double.parseDouble(literal));
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
      // `in` is a WORD, so it counts only when what surrounds it cannot continue an identifier —
      // otherwise a sequence called "index" would be read as the operator followed by "dex".
      if (src.startsWith("in", pos)) {
        boolean afterOk = pos + 2 >= src.length() || !isWordChar(src.charAt(pos + 2));
        boolean beforeOk = pos == 0 || !isWordChar(src.charAt(pos - 1));
        if (afterOk && beforeOk) {
          return "in";
        }
      }
      // Longest first, so `<=` is never read as `<` followed by a stray `=`, and `&&` never as
      // two `&`.
      for (String op :
          List.of(">>>", "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "<", ">",
              "+", "-", "*", "/", "%", "&", "|", "^")) {
        if (src.startsWith(op, pos)) {
          return op;
        }
      }
      return null;
    }
  }
}
