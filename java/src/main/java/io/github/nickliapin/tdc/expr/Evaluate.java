package io.github.nickliapin.tdc.expr;

import java.util.List;
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

  /**
   * The expression's VALUE rather than its truth.
   *
   * <p>The same evaluator an {@code if=} uses — a formula and a distribution parameter are the same
   * language asking for the answer instead of the verdict, which is what keeps a condition and a
   * computed column from coming to mean different things by the same words.
   */
  public static Object asValue(String source, Scope scope) {
    return eval(CACHE.computeIfAbsent(source, Expr::parse), scope);
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
          yield checked(() -> Math.addExact(w[0], w[1]), () -> big(w[0]).add(big(w[1])));
        }
        yield left instanceof Double || right instanceof Double
            ? (Object) (asNumber(left) + asNumber(right))
            : text(left) + text(right);
      }
      case "-" -> {
        long[] w = bothWhole(left, right);
        yield w == null
            ? (Object) (asNumber(left) - asNumber(right))
            : checked(() -> Math.subtractExact(w[0], w[1]), () -> big(w[0]).subtract(big(w[1])));
      }
      case "*" -> {
        long[] w = bothWhole(left, right);
        yield w == null
            ? (Object) (asNumber(left) * asNumber(right))
            : checked(() -> Math.multiplyExact(w[0], w[1]), () -> big(w[0]).multiply(big(w[1])));
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
      // A whole number already IS its own rounding, whatever its size, and taking it through
      // a double first throws that answer away past 2^53. Arithmetic stayed exact, so the
      // value arrives intact and must not be destroyed on the way out.
      case "abs": {
        Long whole = whole(args, 0);
        if (whole != null) {
          return whole < 0 ? checkedNegate(whole) : whole;
        }
        return Math.abs(num(args, 0));
      }
      case "ceil": {
        Long whole = whole(args, 0);
        return whole == null ? (Object) Math.ceil(num(args, 0)) : whole;
      }
      case "floor": {
        Long whole = whole(args, 0);
        return whole == null ? (Object) Math.floor(num(args, 0)) : whole;
      }
      case "trunc": {
        Long whole = whole(args, 0);
        if (whole != null) {
          return whole;
        }
        double x = num(args, 0);
        return x < 0 ? Math.ceil(x) : Math.floor(x);
      }
      case "round": {
        Long whole = whole(args, 0);
        if (whole != null) {
          return whole;
        }
        double x = num(args, 0);
        return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
      }
      // One list argument spread out, or the arguments themselves — so
      // max(split(Prices, ",")) and max(1, 9, 4) both work.
      case "max":
        return extremum(args, true);
      case "min":
        return extremum(args, false);
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
        // Lists inside one row. A sequence with repeat= puts several values in one field, and
        // an expression sees the JOINED text because that is what the field holds — so `split`
        // is the bridge and everything else works on lists. No grammar changed: the list value
        // already existed, made by an array literal and consumed by `in`.
      case "split":
        return splitText(str(args, 0), str(args, 1));
      case "join": {
        StringBuilder out = new StringBuilder();
        String separator = str(args, 1);
        java.util.List<Object> items = listOf(args, 0);
        for (int i = 0; i < items.size(); i++) {
          if (i > 0) {
            out.append(separator);
          }
          out.append(text(items.get(i)));
        }
        return out.toString();
      }
        // How many. `len` is the STRING length and would answer about the separators.
      case "count":
        return (double) listOf(args, 0).size();
      case "at": {
        java.util.List<Object> items = listValue(args, 0);
        int index = indexValue(args, 1);
        if (index >= items.size()) {
          return "";
        }
        Object element = items.get(index);
        return element == null ? "" : element;
      }
      case "sum":
        return sumOf(listOf(args, 0));
      case "mean":
        return meanOf(listOf(args, 0));
      case "median":
        return medianOf(listOf(args, 0));
      case "stddev":
        return stdDevOf(listOf(args, 0));
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

  /** One list argument spread out, or the arguments themselves. */
  @SuppressWarnings("unchecked")
  /** The argument as an exact whole number, or null when it is not one. */
  private static Long whole(Object[] args, int i) {
    return i < args.length ? asExactInt(args[i]) : null;
  }

  /**
   * {@code min} / {@code max}, exact while EVERY argument is a whole number.
   *
   * <p>One float among them and the whole comparison falls to floating point, which is honest:
   * there is no exact ordering between a big integer and a float that is not one. The winner is
   * handed back as it was given, so {@code max(9007199254740993, 1)} answers with the number
   * somebody wrote.
   */
  private static Object extremum(Object[] args, boolean wantsMax) {
    java.util.List<Object> items = spread(args);
    java.util.List<Long> whole = new java.util.ArrayList<>(items.size());
    for (Object v : items) {
      Long n = asExactInt(v);
      if (n == null) {
        whole.clear();
        break;
      }
      whole.add(n);
    }
    if (whole.size() == items.size() && !whole.isEmpty()) {
      long best = whole.get(0);
      for (long n : whole) {
        best = wantsMax ? Math.max(best, n) : Math.min(best, n);
      }
      return best;
    }
    double best = asNumber(items.get(0));
    for (Object v : items) {
      best = wantsMax ? Math.max(best, asNumber(v)) : Math.min(best, asNumber(v));
    }
    return best;
  }

  private static java.util.List<Object> spread(Object[] args) {
    if (args.length == 1 && args[0] instanceof java.util.List<?> only) {
      return (java.util.List<Object>) only;
    }
    return java.util.Arrays.asList(args);
  }

  /**
   * An argument as a list.
   *
   * <p>A bare value counts as a list of one, so {@code sum(Price)} on a single number is an answer
   * rather than an error — the alternative is a rule a caller has to remember before every call.
   */
  @SuppressWarnings("unchecked")
  private static java.util.List<Object> listOf(Object[] args, int index) {
    if (index >= args.length) {
      throw new IllegalArgumentException(
          "if expression: a function was given too few arguments");
    }
    Object value = args[index];
    if (value instanceof java.util.List<?> items) {
      return (java.util.List<Object>) items;
    }
    return value == null ? java.util.List.of() : java.util.List.of(value);
  }

  /**
   * {@code at}'s subject, which has to be a real list.
   *
   * <p>{@link #listOf} reads a bare value as a list of one, which is right for {@code sum(Price)}
   * and wrong here: a {@code repeat} list arrives as the JOINED text, so {@code at(Items, 1)} — the
   * shape everybody writes first — used to ask for the second element of a one-element list and get
   * the same empty string a legitimately short row gives. Naming the mistake is the point.
   */
  @SuppressWarnings("unchecked")
  private static java.util.List<Object> listValue(Object[] args, int index) {
    if (index >= args.length) {
      throw new IllegalArgumentException(
          "if expression: a function was given too few arguments");
    }
    if (args[index] instanceof java.util.List<?> items) {
      return (java.util.List<Object>) items;
    }
    throw new IllegalArgumentException(
        "at() needs a list, and "
            + show(args[index])
            + " is a single value — split it first, as in at(split(Items, \",\"), 1)");
  }

  /** An index: a whole number, zero or more. Anything else is a mistake, not a shape. */
  private static int indexValue(Object[] args, int index) {
    if (index >= args.length) {
      throw new IllegalArgumentException(
          "if expression: a function was given too few arguments");
    }
    Object raw = args[index];
    double n = asNumber(raw);
    if (Double.isNaN(n) || Double.isInfinite(n) || n != Math.floor(n) || n < 0) {
      throw new IllegalArgumentException(
          "at() index must be a whole number of zero or more, not " + show(raw));
    }
    return (int) Math.min(n, Integer.MAX_VALUE);
  }

  /** A value as it should read inside a message: text quoted, everything else plain. */
  private static String show(Object v) {
    if (v instanceof String s) {
      return "\"" + s + "\"";
    }
    if (v instanceof java.util.List<?>) {
      return "a list";
    }
    return v == null ? "nothing" : text(v);
  }

  /** Text to a list. An empty subject gives an empty list, not a list of one blank. */
  private static java.util.List<Object> splitText(String subject, String separator) {
    java.util.List<Object> items = new java.util.ArrayList<>();
    if (subject.isEmpty()) {
      return items;
    }
    if (separator.isEmpty()) {
      // CODE POINTS, the same unit `len` counts, so split(s, "") and len(s) never disagree
      // about how many characters a string has.
      subject.codePoints().forEach(cp -> items.add(new String(Character.toChars(cp))));
      return items;
    }
    int from = 0;
    int hit = subject.indexOf(separator, from);
    while (hit >= 0) {
      items.add(subject.substring(from, hit));
      from = hit + separator.length();
      hit = subject.indexOf(separator, from);
    }
    items.add(subject.substring(from));
    return items;
  }

  /** The total. Whole while every element is whole, so a column of ids stays exact. */
  private static Object sumOf(java.util.List<Object> items) {
    long[] parts = new long[items.size()];
    boolean allWhole = !items.isEmpty();
    for (int i = 0; i < items.size() && allWhole; i++) {
      Long n = asExactInt(items.get(i));
      if (n == null) {
        allWhole = false;
      } else {
        parts[i] = n;
      }
    }
    if (allWhole) {
      return checked(
          () -> {
            long total = 0;
            for (long n : parts) {
              total = Math.addExact(total, n);
            }
            return total;
          },
          () -> {
            java.math.BigInteger total = java.math.BigInteger.ZERO;
            for (long n : parts) {
              total = total.add(java.math.BigInteger.valueOf(n));
            }
            return total;
          });
    }
    double sum = 0;
    for (Object item : items) {
      sum += asNumber(item);
    }
    return sum;
  }

  /** The average. Always a double: a mean is a ratio, and ratios are not whole. */
  private static double meanOf(java.util.List<Object> items) {
    if (items.isEmpty()) {
      return Double.NaN;
    }
    double sum = 0;
    for (Object item : items) {
      sum += asNumber(item);
    }
    return sum / items.size();
  }

  /** The middle value; with an even count, the average of the two middle ones. */
  private static double medianOf(java.util.List<Object> items) {
    if (items.isEmpty()) {
      return Double.NaN;
    }
    double[] sorted = new double[items.size()];
    for (int i = 0; i < items.size(); i++) {
      sorted[i] = asNumber(items.get(i));
    }
    java.util.Arrays.sort(sorted);
    int half = sorted.length / 2;
    return sorted.length % 2 == 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
  }

  /**
   * The POPULATION standard deviation — divided by n, not by n-1.
   *
   * <p>A generated list is the whole of what it describes, not a sample drawn from something
   * larger, so n is the honest divisor. Stated because the two differ and neither is obvious.
   */
  private static double stdDevOf(java.util.List<Object> items) {
    if (items.isEmpty()) {
      return Double.NaN;
    }
    double[] values = new double[items.size()];
    double average = 0;
    for (int i = 0; i < items.size(); i++) {
      values[i] = asNumber(items.get(i));
      average += values[i];
    }
    average /= values.length;
    double variance = 0;
    for (double v : values) {
      variance += (v - average) * (v - average);
    }
    return io.github.nickliapin.tdc.mathx.TdcMath.sqrt(variance / values.length);
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
    // A number the config WROTE, beside text that reads as one. Both shapes of number count,
    // and the whole-number half is the repair of a bug that had every money column silently
    // failing its own equality test: `Total == 100` was false while `Total > 99` was true,
    // because 100 is a whole number and "100.00" is not, so the two never met.
    if (isWritten(left) && right instanceof String s) {
      double b = jsNumber(s);
      if (!Double.isNaN(b)) {
        return asNumber(left) == b;
      }
    }
    if (isWritten(right) && left instanceof String s) {
      double a = jsNumber(s);
      if (!Double.isNaN(a)) {
        return a == asNumber(right);
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
    // Two texts stay text, whatever they look like: an empty column and a blank one are not
    // equal even though both read as zero. Only a literal drags a column into numbers.
    return text(left).equals(text(right));
  }

  /** A number as the config wrote it, rather than as a column produced it. */
  private static boolean isWritten(Object v) {
    return v instanceof Double || v instanceof Long;
  }

  /* ── The two equalities ──────────────────────────────────────────────────────
   *
   * A TDC column is TEXT. Every generator produces text, every built-in is text, and the only
   * things that are not text are the literals someone writes inside an expression. So "are
   * these equal?" has two honest readings, and TDC gives each one its own operator — the shape
   * Perl settled on for the same reason, where a scalar is likewise text that might be a
   * number:
   *
   *     ==   the same NUMBER   "01" == 1     true
   *     ===  the same TEXT     "01" === 1    false
   *
   * `===` used to be the host language's identity test — "same type AND same value". That is a
   * fine question in a language with types and a meaningless one here, because there is only
   * ever one type: `N === 1` was false for EVERY number on every row, silently, with `check`
   * passing.
   */

  /**
   * {@code ===} — do both sides print the same characters?
   *
   * <p>A list never matches, itself included: {@code in} is the operator for lists, and TDC259
   * refuses one anywhere else before the run. Answering false keeps all five implementations
   * saying the same thing rather than leaving each host's idea of list equality to decide it.
   */
  private static boolean strictEquals(Object left, Object right) {
    if (left instanceof List<?> || right instanceof List<?>) {
      return false;
    }
    return strictText(left).equals(strictText(right));
  }

  /**
   * The characters a value prints as.
   *
   * <p>Nothing — an absent column, the {@code null} literal — is the EMPTY text, the same thing
   * a column that produced no value holds. One rule instead of two: absent is empty, here and
   * in {@code toBoolean} and in the output.
   */
  private static String strictText(Object v) {
    if (v == null) {
      return "";
    }
    if (v instanceof String s) {
      return s;
    }
    if (v instanceof Boolean b) {
      return b ? "true" : "false";
    }
    // Printed from the integer itself, not through a double: past 2^53 the round trip would put
    // back the digit the exact domain exists to keep.
    if (v instanceof Long n) {
      return n.toString();
    }
    return text(v);
  }

  /**
   * What counts as TRUE — for a bare {@code if="X"}, and for {@code !}, {@code &&} and {@code
   * ||}.
   *
   * <p>Two texts are false and every other text is true: the empty one (the column produced
   * nothing) and "false" (a flag column saying no). {@code "0"} is TRUE — zero is a value, not
   * an absence. That is Lua's and Ruby's rule carried into a language whose single carrier is
   * text. {@code _last}, {@code _first} and every {@code anomaly_flag} column hold literally
   * "true" or "false", so without this {@code if="!_last"} would be true on every row.
   */
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
    // A whole number is false only at zero, like the double beside it.
    if (v instanceof Long n) {
      return n != 0;
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

  private static java.math.BigInteger big(long v) {
    return java.math.BigInteger.valueOf(v);
  }

  private static Object checkedNegate(long v) {
    return checked(() -> Math.negateExact(v), () -> java.math.BigInteger.valueOf(v).negate());
  }

  /**
   * The result of whole-number arithmetic, refused rather than wrapped.
   *
   * <p>The refusal NAMES the value, as the compute layer's does. Reaching it needs arithmetic
   * wider than the domain, so {@code wide} runs only once the fast path has already said no — the
   * ordinary case never pays for the allocation.
   */
  private static Object checked(
      java.util.function.LongSupplier compute,
      java.util.function.Supplier<java.math.BigInteger> wide) {
    try {
      return compute.getAsLong();
    } catch (ArithmeticException overflow) {
      throw new IllegalArgumentException(
          "integer overflow: " + wide.get() + " is outside the signed 64-bit range");
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
