package io.github.nickliapin.tdc.expr;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Evaluates a parsed {@link Expr} against the row being rendered.
 *
 * <p>Values live in the same three-type world the reference works in: a number, a string, or a
 * boolean. The rules for moving between them are JavaScript's, with one deliberate change the
 * reference also makes — the string {@code "false"} counts as false. Without that, {@code
 * if="!_last"} would be true on every row, because the string "false" is a non-empty string.
 */
public final class Evaluate {

  /** What a name resolves to. Separate {@code has} because an absent name is not an empty one. */
  public interface Scope {
    boolean has(String name);

    /** The value for {@code name} on the current row; {@code ""} when the row has none. */
    String value(String name);
  }

  private static final Map<String, Expr> CACHE = new ConcurrentHashMap<>();

  private Evaluate() {}

  public static boolean asCondition(String source, Scope scope) {
    Expr ast = CACHE.computeIfAbsent(source, Expr::parse);
    return toBoolean(eval(ast, scope));
  }

  // A chain of `instanceof` rather than a switch over the sealed type: switch patterns are still
  // a preview feature on Java 17, and 17 is the version the docs promise this library runs on.
  private static Object eval(Expr node, Scope scope) {
    if (node instanceof Expr.Num n) {
      return n.value();
    }
    if (node instanceof Expr.Str s) {
      return s.value();
    }
    if (node instanceof Expr.Bool b) {
      return b.value();
    }
    if (node instanceof Expr.Null) {
      return null;
    }
    if (node instanceof Expr.Name n) {
      // An unknown name is its own value, which is what lets `Gender == Male` go unquoted.
      return scope.has(n.value()) ? scope.value(n.value()) : n.value();
    }
    if (node instanceof Expr.Call c) {
      Object[] args = new Object[c.args().size()];
      for (int i = 0; i < args.length; i++) {
        args[i] = eval(c.args().get(i), scope);
      }
      return callFunction(c.callee(), args);
    }
    if (node instanceof Expr.Arr a) {
      java.util.List<Object> items = new java.util.ArrayList<>(a.items().size());
      for (Expr item : a.items()) {
        items.add(eval(item, scope));
      }
      return items;
    }
    if (node instanceof Expr.Conditional t) {
      return toBoolean(eval(t.test(), scope))
          ? eval(t.consequent(), scope)
          : eval(t.alternate(), scope);
    }
    if (node instanceof Expr.Member m) {
      return member(m.dotted(), scope);
    }
    if (node instanceof Expr.Unary u) {
      return unary(u.op(), eval(u.operand(), scope));
    }
    if (node instanceof Expr.Binary b) {
      return binary(b.op(), eval(b.left(), scope), eval(b.right(), scope));
    }
    throw new IllegalStateException("if expression: unhandled node " + node);
  }

  /**
   * {@code A.B} is read three ways, in order: a compound field named "A.B"; else, when "A" is a
   * sequence, the test "is A currently B?" — so {@code if="Gender.Male"} reads the way {@code
   * parent="Gender.Male"} does; else the dotted text itself, so a typo shows up verbatim
   * instead of silently becoming empty.
   */
  private static Object member(String dotted, Scope scope) {
    if (scope.has(dotted)) {
      return scope.value(dotted);
    }
    int dot = dotted.indexOf('.');
    if (dot > 0 && scope.has(dotted.substring(0, dot))) {
      return scope.value(dotted.substring(0, dot)).equals(dotted.substring(dot + 1));
    }
    return dotted;
  }

  private static Object unary(String op, Object arg) {
    return switch (op) {
      case "!" -> !toBoolean(arg);
      case "-" -> -asNumber(arg);
      case "+" -> asNumber(arg);
      default -> throw new IllegalArgumentException("if expression: unsupported operator " + op);
    };
  }

  private static Object binary(String op, Object left, Object right) {
    return switch (op) {
      case "==" -> looseEquals(left, right);
      case "!=" -> !looseEquals(left, right);
      case "===" -> strictEquals(left, right);
      case "!==" -> !strictEquals(left, right);
      case "<" -> asNumber(left) < asNumber(right);
      case ">" -> asNumber(left) > asNumber(right);
      case "<=" -> asNumber(left) <= asNumber(right);
      case ">=" -> asNumber(left) >= asNumber(right);
      case "&&" -> toBoolean(left) && toBoolean(right);
      case "||" -> toBoolean(left) || toBoolean(right);
      // `+` adds when either side is already a number and joins otherwise, as in JavaScript.
      case "+" ->
          left instanceof Double || right instanceof Double
              ? (Object) (asNumber(left) + asNumber(right))
              : text(left) + text(right);
      case "-" -> asNumber(left) - asNumber(right);
      case "*" -> asNumber(left) * asNumber(right);
      case "/" -> asNumber(left) / asNumber(right);
      case "%" -> euclideanRemainder(asNumber(left), asNumber(right));
      // As loose as `==`, deliberately: a text column against a list of numeric words has to
      // match, or `in` and `==` would disagree about the same pair.
      case "in" -> {
        if (right instanceof java.util.List<?> items) {
          boolean found = false;
          for (Object candidate : items) {
            if (looseEquals(left, candidate)) {
              found = true;
              break;
            }
          }
          yield found;
        }
        yield looseEquals(left, right);
      }
      default -> throw new IllegalArgumentException("if expression: unsupported operator " + op);
    };
  }

  /**
   * {@code %} — the EUCLIDEAN remainder, always in {@code [0, |b|)}.
   *
   * <p>Not Java's {@code %}, which takes the sign of the dividend and answers -1 to {@code -3 %
   * 2}. The compute layer's {@code <mod>} answers 1, and one engine must not give two answers
   * depending on which layer the author reached for.
   */
  private static double euclideanRemainder(double a, double b) {
    if (b == 0) {
      throw new IllegalArgumentException("if expression: the right side of % must not be zero");
    }
    double magnitude = Math.abs(b);
    double r = a % magnitude;
    return r < 0 ? r + magnitude : r;
  }

  /**
   * The functions an {@code if=} may call.
   *
   * <p>Every one is EXACT — comparisons and the arithmetic IEEE-754 pins down — so the five
   * implementations cannot disagree about a result. sin, cos, exp and the rest are absent for
   * exactly that reason; the validator answers them with it.
   *
   * <p>{@code round} is written out rather than delegated: Java's {@code Math.round} sends a half
   * UP (so -0.5 becomes 0), JavaScript sends it toward +inf, Python to even. TDC sends a half AWAY
   * FROM ZERO, which is symmetric.
   */
  private static Object callFunction(String name, Object[] args) {
    if (args.length == 0) {
      throw new IllegalArgumentException(
          "if expression: a function needs at least one argument");
    }
    switch (name) {
      case "abs":
        return Math.abs(num(args, 0));
      case "ceil":
        return Math.ceil(num(args, 0));
      case "floor":
        return Math.floor(num(args, 0));
      case "trunc": {
        double x = num(args, 0);
        return x < 0 ? Math.ceil(x) : Math.floor(x);
      }
      case "round": {
        double x = num(args, 0);
        return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
      }
      case "max": {
        double best = asNumber(args[0]);
        for (Object v : args) {
          best = Math.max(best, asNumber(v));
        }
        return best;
      }
      case "min": {
        double best = asNumber(args[0]);
        for (Object v : args) {
          best = Math.min(best, asNumber(v));
        }
        return best;
      }
      case "contains":
        return str(args, 0).contains(str(args, 1));
      case "ends_with":
        return str(args, 0).endsWith(str(args, 1));
      case "starts_with":
        return str(args, 0).startsWith(str(args, 1));
      case "is_empty":
        return str(args, 0).isEmpty();
      case "len": {
        // CODE POINTS, matching Python's len() and Rust's chars().count(). Java's own
        // String.length() counts UTF-16 units and would make an emoji 2.
        String s = str(args, 0);
        return (double) s.codePointCount(0, s.length());
      }
      case "lower":
        return str(args, 0).toLowerCase(java.util.Locale.ROOT);
      case "upper":
        return str(args, 0).toUpperCase(java.util.Locale.ROOT);
      default:
        throw new IllegalArgumentException(
            "if expression: unknown function \"" + name + "\"");
    }
  }

  /**
   * Each family coerces its own arguments.
   *
   * <p>The string functions must NOT be numbered: {@code len("10")} is 2, and a caller that
   * pre-numbered every argument could not tell the two families apart.
   */
  private static double num(Object[] args, int index) {
    if (index >= args.length) {
      throw new IllegalArgumentException(
          "if expression: a function was given too few arguments");
    }
    return asNumber(args[index]);
  }

  private static String str(Object[] args, int index) {
    if (index >= args.length) {
      throw new IllegalArgumentException(
          "if expression: a function was given too few arguments");
    }
    if (args[index] instanceof java.util.List<?>) {
      throw new IllegalArgumentException("if expression: a string function was given a list");
    }
    return text(args[index]);
  }

  /**
   * Loose equality. A number against a numeric-looking string compares as numbers, so {@code
   * _count == 5} works even though {@code _count} arrives as text; everything else compares as
   * text.
   */
  private static boolean looseEquals(Object left, Object right) {
    if (left instanceof Double a && right instanceof String s) {
      double b = jsNumber(s);
      if (!Double.isNaN(b)) {
        return a == b;
      }
    }
    if (right instanceof Double b && left instanceof String s) {
      double a = jsNumber(s);
      if (!Double.isNaN(a)) {
        return a == b;
      }
    }
    if (left == null || right == null) {
      return left == null && right == null;
    }
    if (left instanceof Boolean || right instanceof Boolean) {
      return asNumber(left) == asNumber(right);
    }
    if (left instanceof Double a && right instanceof Double b) {
      return a.doubleValue() == b.doubleValue();
    }
    return text(left).equals(text(right));
  }

  private static boolean strictEquals(Object left, Object right) {
    if (left == null || right == null) {
      return left == right;
    }
    return left.getClass() == right.getClass() && left.equals(right);
  }

  public static boolean toBoolean(Object v) {
    if (v == null) {
      return false;
    }
    if (v instanceof String s) {
      return !s.isEmpty() && !"false".equals(s);
    }
    if (v instanceof Boolean b) {
      return b;
    }
    if (v instanceof Double d) {
      return d != 0 && !Double.isNaN(d);
    }
    return true;
  }

  private static double asNumber(Object v) {
    if (v instanceof Double d) {
      return d;
    }
    if (v instanceof String s) {
      return jsNumber(s);
    }
    if (v instanceof Boolean b) {
      return b ? 1 : 0;
    }
    return Double.NaN;
  }

  /** {@code Number(x)} as JavaScript defines it: blank is zero, anything unreadable is NaN. */
  private static double jsNumber(String raw) {
    String s = raw.trim();
    if (s.isEmpty()) {
      return 0;
    }
    try {
      if (s.startsWith("0x") || s.startsWith("0X")) {
        return Long.parseLong(s.substring(2), 16);
      }
      // Java accepts "1d", "1f" and leading "+"; JavaScript does not read the suffixes.
      char last = s.charAt(s.length() - 1);
      if (last == 'd' || last == 'D' || last == 'f' || last == 'F') {
        return Double.NaN;
      }
      return Double.parseDouble(s);
    } catch (NumberFormatException e) {
      return Double.NaN;
    }
  }

  /** {@code String(x)}: a whole number prints without a decimal point, as in JavaScript. */
  private static String text(Object v) {
    if (v == null) {
      return "null";
    }
    if (v instanceof Double d) {
      if (d == Math.rint(d) && !Double.isInfinite(d)) {
        return String.valueOf((long) (double) d);
      }
      return String.valueOf((double) d);
    }
    return String.valueOf(v);
  }
}
