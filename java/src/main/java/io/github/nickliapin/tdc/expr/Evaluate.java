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
    if (node instanceof Expr.Int n) {
      return n.value();
    }
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
      case "-" -> {
        Long whole = asExactInt(arg);
        yield whole == null ? (Object) (-asNumber(arg)) : checkedNegate(whole);
      }
      case "+" -> {
        Long whole = asExactInt(arg);
        yield whole == null ? (Object) asNumber(arg) : whole;
      }
      default -> throw new IllegalArgumentException("if expression: unsupported operator " + op);
    };
  }

  private static Object binary(String op, Object left, Object right) {
    return switch (op) {
      case "==" -> looseEquals(left, right);
      case "!=" -> !looseEquals(left, right);
      case "===" -> strictEquals(left, right);
      case "!==" -> !strictEquals(left, right);
      case "<" -> {
        long[] w = bothWhole(left, right);
        yield w == null ? asNumber(left) < asNumber(right) : w[0] < w[1];
      }
      case ">" -> {
        long[] w = bothWhole(left, right);
        yield w == null ? asNumber(left) > asNumber(right) : w[0] > w[1];
      }
      case "<=" -> {
        long[] w = bothWhole(left, right);
        yield w == null ? asNumber(left) <= asNumber(right) : w[0] <= w[1];
      }
      case ">=" -> {
        long[] w = bothWhole(left, right);
        yield w == null ? asNumber(left) >= asNumber(right) : w[0] >= w[1];
      }
      case "&&" -> toBoolean(left) && toBoolean(right);
      case "||" -> toBoolean(left) || toBoolean(right);
      // `+` adds when either side is already a number and joins otherwise, as in JavaScript.
      case "+" -> {
        long[] w = bothWhole(left, right);
        if (w != null) {
          yield checked(() -> Math.addExact(w[0], w[1]));
        }
        yield left instanceof Double || right instanceof Double
            ? (Object) (asNumber(left) + asNumber(right))
            : text(left) + text(right);
      }
      case "-" -> {
        long[] w = bothWhole(left, right);
        yield w == null
            ? (Object) (asNumber(left) - asNumber(right))
            : checked(() -> Math.subtractExact(w[0], w[1]));
      }
      case "*" -> {
        long[] w = bothWhole(left, right);
        yield w == null
            ? (Object) (asNumber(left) * asNumber(right))
            : checked(() -> Math.multiplyExact(w[0], w[1]));
      }
      // Division alone stays in floating point, always. It is not closed over the whole
      // numbers — 7/2 is not one — and a rule that came out exact only when the division
      // happened to be even would be a rule nobody could hold in their head.
      case "/" -> asNumber(left) / asNumber(right);
      case "%" -> {
        long[] w = bothWhole(left, right);
        if (w != null && w[1] != 0) {
          // Euclidean, like the double path and like <mod> in compute.
          long r = w[0] % w[1];
          yield r < 0 ? r + Math.abs(w[1]) : r;
        }
        yield euclideanRemainder(asNumber(left), asNumber(right));
      }
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
        // Transcendentals, computed by TDC rather than by Java — see mathx/TdcMath.java.
        // Adding one here means adding it to TdcMath in all five, not calling java.lang.Math.
      case "acos":
        return io.github.nickliapin.tdc.mathx.TdcMath.acos(num(args, 0));
      case "beta":
        return io.github.nickliapin.tdc.mathx.TdcMath.beta(num(args, 0), num(args, 1));
      case "degrees":
        return io.github.nickliapin.tdc.mathx.TdcMath.degrees(num(args, 0));
      case "digamma":
        return io.github.nickliapin.tdc.mathx.TdcMath.digamma(num(args, 0));
      case "radians":
        return io.github.nickliapin.tdc.mathx.TdcMath.radians(num(args, 0));
      case "zeta":
        return io.github.nickliapin.tdc.mathx.TdcMath.zeta(num(args, 0));
      case "erf":
        return io.github.nickliapin.tdc.mathx.TdcMath.erf(num(args, 0));
      case "erfc":
        return io.github.nickliapin.tdc.mathx.TdcMath.erfc(num(args, 0));
      case "gamma":
        return io.github.nickliapin.tdc.mathx.TdcMath.gamma(num(args, 0));
      case "lgamma":
        return io.github.nickliapin.tdc.mathx.TdcMath.lgamma(num(args, 0));
      case "acosh":
        return io.github.nickliapin.tdc.mathx.TdcMath.acosh(num(args, 0));
      case "asinh":
        return io.github.nickliapin.tdc.mathx.TdcMath.asinh(num(args, 0));
      case "atanh":
        return io.github.nickliapin.tdc.mathx.TdcMath.atanh(num(args, 0));
      case "expm1":
        return io.github.nickliapin.tdc.mathx.TdcMath.expm1(num(args, 0));
      case "hypot":
        return io.github.nickliapin.tdc.mathx.TdcMath.hypot(num(args, 0), num(args, 1));
      case "log1p":
        return io.github.nickliapin.tdc.mathx.TdcMath.log1p(num(args, 0));
      case "log2":
        return io.github.nickliapin.tdc.mathx.TdcMath.log2(num(args, 0));
      case "sign":
        return io.github.nickliapin.tdc.mathx.TdcMath.sign(num(args, 0));
      case "asin":
        return io.github.nickliapin.tdc.mathx.TdcMath.asin(num(args, 0));
      case "atan":
        return io.github.nickliapin.tdc.mathx.TdcMath.atan(num(args, 0));
      case "atan2":
        return io.github.nickliapin.tdc.mathx.TdcMath.atan2(num(args, 0), num(args, 1));
      case "cbrt":
        return io.github.nickliapin.tdc.mathx.TdcMath.cbrt(num(args, 0));
      case "cos":
        return io.github.nickliapin.tdc.mathx.TdcMath.cos(num(args, 0));
      case "cosh":
        return io.github.nickliapin.tdc.mathx.TdcMath.cosh(num(args, 0));
      case "exp":
        return io.github.nickliapin.tdc.mathx.TdcMath.exp(num(args, 0));
      case "log":
        return io.github.nickliapin.tdc.mathx.TdcMath.log(num(args, 0));
      case "log10":
        return io.github.nickliapin.tdc.mathx.TdcMath.log10(num(args, 0));
      case "pow":
        return io.github.nickliapin.tdc.mathx.TdcMath.pow(num(args, 0), num(args, 1));
      case "sin":
        return io.github.nickliapin.tdc.mathx.TdcMath.sin(num(args, 0));
      case "sinh":
        return io.github.nickliapin.tdc.mathx.TdcMath.sinh(num(args, 0));
      case "sqrt":
        return io.github.nickliapin.tdc.mathx.TdcMath.sqrt(num(args, 0));
      case "tanh":
        return io.github.nickliapin.tdc.mathx.TdcMath.tanh(num(args, 0));
      case "tan":
        return io.github.nickliapin.tdc.mathx.TdcMath.tan(num(args, 0));
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
    // Two whole numbers compare as whole numbers, whichever shape they arrived
    // in — a generated id is a string, the literal beside it is not.
    long[] w = bothWhole(left, right);
    if (w != null) {
      return w[0] == w[1];
    }
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

  /* ── Whole numbers that stay whole ──────────────────────────────────────────
   *
   * A double holds every integer up to 2^53 and then starts skipping. Past that
   * point two DIFFERENT whole numbers become the same double, and an expression
   * built on doubles alone answers accordingly:
   *
   *     9007199254740993 == 9007199254740992   ->  true
   *     9007199254740993 -  9007199254740992   ->  0
   *
   * Both wrong, and wrong silently — the worst way for a data generator to be
   * wrong, since the run finishes and the file looks fine. The domain is signed
   * 64-bit, matching the compute layer.
   */

  /** A value seen as an exact whole number, or null if it is not one. */
  private static Long asExactInt(Object v) {
    if (v instanceof Long n) {
      return n;
    }
    if (v instanceof String s) {
      String body =
          !s.isEmpty() && (s.charAt(0) == '+' || s.charAt(0) == '-') ? s.substring(1) : s;
      if (body.isEmpty() || !body.chars().allMatch(Character::isDigit)) {
        return null;
      }
      try {
        return Long.parseLong(s);
      } catch (NumberFormatException outsideTheDomain) {
        return null;
      }
    }
    // A double is admitted only while it is still exact. Past 2^53 it has already
    // lost the answer, and calling it exact would be the same lie in another place.
    if (v instanceof Double d && d % 1 == 0 && Math.abs(d) <= 9007199254740991d) {
      return (long) (double) d;
    }
    return null;
  }

  /** Both operands as exact whole numbers, or null if either is not one. */
  private static long[] bothWhole(Object left, Object right) {
    Long a = asExactInt(left);
    if (a == null) {
      return null;
    }
    Long b = asExactInt(right);
    return b == null ? null : new long[] {a, b};
  }

  private static Object checkedNegate(long v) {
    return checked(() -> Math.negateExact(v));
  }

  /** The result of whole-number arithmetic, refused rather than wrapped. */
  private static Object checked(java.util.function.LongSupplier compute) {
    try {
      return compute.getAsLong();
    } catch (ArithmeticException overflow) {
      throw new IllegalArgumentException(
          "integer overflow: the result is outside the signed 64-bit range");
    }
  }

  private static double asNumber(Object v) {
    if (v instanceof Double d) {
      return d;
    }
    // A whole number handed to something that works in floating point — sqrt, log,
    // sin. Past 2^53 this loses digits, which is the honest answer.
    if (v instanceof Long n) {
      return n;
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
