package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Random;
import io.github.nickliapin.tdc.unicode.Alphabets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code <gen type="regex" value="..."/>} — a value that matches a pattern.
 *
 * <p>Deliberately not the platform's regular-expression engine. Two reasons, and both are about
 * the product rather than about convenience:
 *
 * <ul>
 *   <li>This runs a pattern <em>forwards</em>, producing a string, where an engine runs one
 *       backwards to test a string. Nothing in the JDK does the forward direction.
 *   <li>Every pattern here has a finite longest output, checked before a single value is made.
 *       {@code *} and {@code +} are rejected outright, and {@code .} means a printable ASCII
 *       character rather than "almost anything". A config that asked for an unbounded pattern
 *       would otherwise be a request for an arbitrarily large file.
 * </ul>
 *
 * <p>The subset is portable on purpose: no platform's dialect quirks, no Unicode property
 * classes, no lookaround. What is accepted produces the same string from the same seed in every
 * implementation of TDC.
 */
public final class RegexGen {

  public static final int DEFAULT_MAX_LENGTH = 32;

  static final List<String> DIGITS = Alphabets.between('0', '9');
  static final List<String> LOWER = Alphabets.between('a', 'z');
  static final List<String> UPPER = Alphabets.between('A', 'Z');
  static final List<String> PRINTABLE_ASCII = Alphabets.between(' ', '~');
  static final List<String> WORD = word();
  static final List<String> SPACES = List.of(" ", "\t");

  private static List<String> word() {
    List<String> out = new ArrayList<>(UPPER);
    out.addAll(LOWER);
    out.addAll(DIGITS);
    out.add("_");
    return List.copyOf(out);
  }

  // ── the tree ─────────────────────────────────────────────────────────────────────────────

  public sealed interface Node {}

  record Empty() implements Node {}

  record Literal(String value) implements Node {}

  record Chars(List<String> chars) implements Node {}

  record Sequence(List<Node> parts) implements Node {}

  record Alternation(List<Node> choices) implements Node {}

  record Repeat(Node node, int min, int max) implements Node {}

  record Capture(int index, Node node, long maxLength) implements Node {}

  record Backref(int index) implements Node {}

  private RegexGen() {}

  public static List<String> generate(
      Map<String, String> attrs, int count, int documentMaxLength, Prng.Sfc32 prng) {
    // A limit on the tag itself wins over the document's. That is how a pack can ship a UUID
    // pattern — 36 characters, well past the default 32 — without every config having to
    // raise its own ceiling to accommodate it.
    int limit =
        attrs.get("regex_max_length") != null
            ? parseMaxLength(attrs.get("regex_max_length"))
            : documentMaxLength;
    Node root = compile(attrs.getOrDefault("value", ""), limit);
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add(render(root, new HashMap<>(), prng));
    }
    return out;
  }

  public static Node compile(String pattern, int regexMaxLength) {
    Parser parser = new Parser(pattern);
    Node root = parser.parse();
    long maxLength = maxLength(root, parser.captureMaxLengths);
    if (maxLength > regexMaxLength) {
      throw new IllegalArgumentException(
          "regex can produce "
              + maxLength
              + " characters, which exceeds regex_max_length="
              + regexMaxLength);
    }
    return root;
  }

  public static int parseMaxLength(String raw) {
    if (raw == null) {
      return DEFAULT_MAX_LENGTH;
    }
    int value;
    try {
      value = Integer.parseInt(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "regex_max_length must be a positive integer, got \"" + raw + "\"");
    }
    if (value <= 0) {
      throw new IllegalArgumentException(
          "regex_max_length must be a positive integer, got \"" + raw + "\"");
    }
    return value;
  }

  // ── generating ───────────────────────────────────────────────────────────────────────────

  private static String render(Node node, Map<Integer, String> captures, Prng.Sfc32 prng) {
    if (node instanceof Empty) {
      return "";
    }
    if (node instanceof Literal l) {
      return l.value();
    }
    if (node instanceof Chars c) {
      return Random.pick(prng, c.chars());
    }
    if (node instanceof Sequence s) {
      StringBuilder out = new StringBuilder();
      // In order, always. Each part may take draws, so a different order is different data.
      for (Node part : s.parts()) {
        out.append(render(part, captures, prng));
      }
      return out.toString();
    }
    if (node instanceof Alternation a) {
      return render(Random.pick(prng, a.choices()), captures, prng);
    }
    if (node instanceof Repeat r) {
      int times = Random.nextInt(prng, r.min(), r.max() + 1);
      StringBuilder out = new StringBuilder();
      for (int i = 0; i < times; i++) {
        out.append(render(r.node(), captures, prng));
      }
      return out.toString();
    }
    if (node instanceof Capture c) {
      String value = render(c.node(), captures, prng);
      captures.put(c.index(), value);
      return value;
    }
    if (node instanceof Backref b) {
      return captures.getOrDefault(b.index(), "");
    }
    throw new IllegalStateException("regex: unhandled node " + node);
  }

  /** The longest string the pattern can produce — computed before generating, never after. */
  private static long maxLength(Node node, Map<Integer, Long> captureMaxLengths) {
    if (node instanceof Empty) {
      return 0;
    }
    if (node instanceof Literal || node instanceof Chars) {
      return 1;
    }
    if (node instanceof Sequence s) {
      long total = 0;
      for (Node part : s.parts()) {
        total = guard(total + maxLength(part, captureMaxLengths));
      }
      return total;
    }
    if (node instanceof Alternation a) {
      long best = 0;
      for (Node choice : a.choices()) {
        best = Math.max(best, maxLength(choice, captureMaxLengths));
      }
      return best;
    }
    if (node instanceof Repeat r) {
      return guard(maxLength(r.node(), captureMaxLengths) * r.max());
    }
    if (node instanceof Capture c) {
      return c.maxLength();
    }
    if (node instanceof Backref b) {
      return captureMaxLengths.getOrDefault(b.index(), 0L);
    }
    throw new IllegalStateException("regex: unhandled node " + node);
  }

  private static long guard(long value) {
    if (value < 0 || value > Integer.MAX_VALUE) {
      throw new IllegalArgumentException("regex: maximum length is too large");
    }
    return value;
  }

  // ── parsing ──────────────────────────────────────────────────────────────────────────────

  static final class Parser {
    private final String pattern;
    private int pos;
    private int captureCount;
    private int closedCaptureCount;
    final Map<Integer, Long> captureMaxLengths = new HashMap<>();

    Parser(String pattern) {
      this.pattern = pattern;
    }

    Node parse() {
      Node node = alternation();
      if (!atEnd()) {
        throw error("unexpected \"" + peek() + "\"");
      }
      return node;
    }

    private Node alternation() {
      List<Node> choices = new ArrayList<>();
      choices.add(sequence());
      while ("|".equals(peek())) {
        pos++;
        choices.add(sequence());
      }
      return choices.size() == 1 ? choices.get(0) : new Alternation(List.copyOf(choices));
    }

    private Node sequence() {
      List<Node> parts = new ArrayList<>();
      while (!atEnd()) {
        String ch = peek();
        if (")".equals(ch) || "|".equals(ch)) {
          break;
        }
        parts.add(repeatedAtom());
      }
      if (parts.isEmpty()) {
        return new Empty();
      }
      return parts.size() == 1 ? parts.get(0) : new Sequence(List.copyOf(parts));
    }

    private Node repeatedAtom() {
      Node atom = atom();
      String ch = peek();
      if (ch == null) {
        return atom;
      }
      switch (ch) {
        case "?":
          pos++;
          return finishRepeat(atom, 0, 1);
        case "*":
          throw error("unbounded \"*\" quantifier is not allowed; use \"{0,n}\"");
        case "+":
          throw error("unbounded \"+\" quantifier is not allowed; use \"{1,n}\"");
        case "{":
          return boundedRepeat(atom);
        default:
          return atom;
      }
    }

    private Node finishRepeat(Node node, int min, int max) {
      if (max < min) {
        throw error("invalid quantifier bounds {" + min + "," + max + "}");
      }
      String next = peek();
      if ("?".equals(next)) {
        throw error("lazy quantifiers are not supported");
      }
      if ("*".equals(next) || "+".equals(next) || "{".equals(next)) {
        throw error("stacked quantifiers are not supported");
      }
      return new Repeat(node, min, max);
    }

    private Node boundedRepeat(Node node) {
      expect("{");
      String minText = digits();
      if (minText.isEmpty()) {
        throw error("quantifier must start with a number");
      }
      int min = safeInt(minText);
      if ("}".equals(peek())) {
        pos++;
        return finishRepeat(node, min, min);
      }
      expect(",");
      String maxText = digits();
      if (maxText.isEmpty()) {
        throw error("unbounded \"{n,}\" quantifier is not allowed; use \"{n,m}\"");
      }
      int max = safeInt(maxText);
      expect("}");
      return finishRepeat(node, min, max);
    }

    private Node atom() {
      String ch = peek();
      if (ch == null) {
        return new Empty();
      }
      switch (ch) {
        case "(":
          return group();
        case "[":
          return charClass();
        case "\\":
          return escape();
        case ".":
          pos++;
          return chars(PRINTABLE_ASCII);
        case "^":
        case "$":
          // Anchors match a position rather than a character, and a generated value is the
          // whole string, so both are already true. They contribute nothing.
          pos++;
          return new Empty();
        case "*":
        case "+":
        case "?":
        case "{":
          throw error("quantifier \"" + ch + "\" has no target");
        default:
          pos++;
          return new Literal(ch);
      }
    }

    private Node group() {
      expect("(");
      boolean capturing = true;
      if ("?".equals(peek())) {
        if (pattern.startsWith("?:", pos)) {
          pos += 2;
          capturing = false;
        } else {
          throw error("lookaround, named, and conditional groups are not supported");
        }
      }

      int index = 0;
      if (capturing) {
        index = ++captureCount;
      }

      Node node = alternation();
      expect(")");

      if (!capturing) {
        return node;
      }
      // A backreference is only legal once its group has closed, which is what this tracks.
      closedCaptureCount = Math.max(closedCaptureCount, index);
      long groupMax = maxLength(node, captureMaxLengths);
      captureMaxLengths.put(index, groupMax);
      return new Capture(index, node, groupMax);
    }

    private Node charClass() {
      expect("[");
      boolean negated = "^".equals(peek());
      if (negated) {
        pos++;
      }

      List<String> collected = new ArrayList<>();
      boolean sawAtom = false;
      while (!atEnd() && !"]".equals(peek())) {
        sawAtom = true;
        ClassAtom start = classAtom();
        if ("-".equals(peek()) && peekNext() != null && !"]".equals(peekNext())) {
          pos++;
          ClassAtom end = classAtom();
          if (start.single == null || end.single == null) {
            throw error("character class ranges must use single-character endpoints");
          }
          int lo = start.single.codePointAt(0);
          int hi = end.single.codePointAt(0);
          if (lo > hi) {
            throw error("invalid character range \"" + start.single + "-" + end.single + "\"");
          }
          collected.addAll(Alphabets.between(lo, hi));
        } else {
          collected.addAll(start.chars);
        }
      }

      expect("]");
      if (!sawAtom) {
        throw error("empty character classes are not supported");
      }

      Set<String> unique = new LinkedHashSet<>(collected);
      List<String> finalChars;
      if (negated) {
        finalChars = new ArrayList<>();
        for (String ch : PRINTABLE_ASCII) {
          if (!unique.contains(ch)) {
            finalChars.add(ch);
          }
        }
      } else {
        finalChars = new ArrayList<>(unique);
      }
      if (finalChars.isEmpty()) {
        throw error("character class has no available characters");
      }
      return chars(finalChars);
    }

    private record ClassAtom(List<String> chars, String single) {}

    private ClassAtom classAtom() {
      String ch = peek();
      if (ch == null) {
        throw error("unterminated character class");
      }
      if ("\\".equals(ch)) {
        return classEscape();
      }
      pos++;
      return new ClassAtom(List.of(ch), ch);
    }

    private ClassAtom classEscape() {
      expect("\\");
      String ch = escapedChar();
      switch (ch) {
        case "d":
          return new ClassAtom(DIGITS, null);
        case "D":
          return new ClassAtom(inverse(DIGITS), null);
        case "w":
          return new ClassAtom(WORD, null);
        case "W":
          return new ClassAtom(inverse(WORD), null);
        case "s":
          return new ClassAtom(SPACES, null);
        case "S":
          return new ClassAtom(inverse(SPACES), null);
        case "a":
          if (!"{".equals(peek())) {
            return new ClassAtom(List.of(ch), ch);
          }
          return new ClassAtom(namedAlphabet(), null);
        case "n":
        case "r":
          throw error("multiline escapes are not supported");
        case "t":
          return new ClassAtom(List.of("\t"), "\t");
        case "p":
        case "P":
          throw error("Unicode property classes are not supported");
        default:
          return new ClassAtom(List.of(ch), ch);
      }
    }

    private Node escape() {
      expect("\\");
      String ch = escapedChar();
      if (isDigit(ch)) {
        String indexText = ch + digits();
        int index = safeInt(indexText);
        if (index <= 0 || index > closedCaptureCount) {
          throw error(
              "backreference \"\\" + indexText + "\" points to a group that is not generated yet");
        }
        return new Backref(index);
      }

      switch (ch) {
        case "d":
          return chars(DIGITS);
        case "D":
          return chars(inverse(DIGITS));
        case "w":
          return chars(WORD);
        case "W":
          return chars(inverse(WORD));
        case "s":
          return chars(SPACES);
        case "S":
          return chars(inverse(SPACES));
        case "a":
          if (!"{".equals(peek())) {
            return new Literal(ch);
          }
          return chars(namedAlphabet());
        case "n":
        case "r":
          throw error("multiline escapes are not supported");
        case "t":
          return new Literal("\t");
        case "p":
        case "P":
          throw error("Unicode property classes are not supported");
        default:
          return new Literal(ch);
      }
    }

    /** {@code \a{name}} — a named alphabet, the escape that has no equivalent anywhere else. */
    private List<String> namedAlphabet() {
      expect("{");
      StringBuilder name = new StringBuilder();
      while (!atEnd() && !"}".equals(peek())) {
        name.append(peek());
        pos++;
      }
      expect("}");
      if (name.length() == 0) {
        throw error("alphabet escape \"\\a{...}\" requires a non-empty name");
      }
      if (!name.toString().matches("^[A-Za-z0-9._-]+$")) {
        throw error("invalid alphabet name \"" + name + "\"");
      }
      List<String> resolved = Alphabets.chars(name.toString());
      if (resolved == null) {
        throw error("unknown alphabet \"" + name + "\"");
      }
      return resolved;
    }

    private String escapedChar() {
      String ch = peek();
      if (ch == null) {
        throw error("dangling escape at end of pattern");
      }
      pos++;
      return ch;
    }

    private String digits() {
      StringBuilder out = new StringBuilder();
      while (!atEnd() && isDigit(peek())) {
        out.append(peek());
        pos++;
      }
      return out.toString();
    }

    private void expect(String expected) {
      String actual = peek();
      if (!expected.equals(actual)) {
        throw error(
            "expected \"" + expected + "\" but found \"" + (actual == null ? "end of pattern" : actual) + "\"");
      }
      pos++;
    }

    private boolean atEnd() {
      return pos >= pattern.length();
    }

    private String peek() {
      return atEnd() ? null : pattern.substring(pos, pos + 1);
    }

    private String peekNext() {
      return pos + 1 >= pattern.length() ? null : pattern.substring(pos + 1, pos + 2);
    }

    private int safeInt(String text) {
      try {
        int value = Integer.parseInt(text);
        if (value < 0) {
          throw error("invalid quantifier number \"" + text + "\"");
        }
        return value;
      } catch (NumberFormatException e) {
        throw error("invalid quantifier number \"" + text + "\"");
      }
    }

    private IllegalArgumentException error(String message) {
      return new IllegalArgumentException("regex: " + message + " at offset " + pos);
    }
  }

  static boolean isDigit(String ch) {
    return ch != null && ch.length() == 1 && ch.charAt(0) >= '0' && ch.charAt(0) <= '9';
  }

  private static Node chars(List<String> values) {
    return new Chars(List.copyOf(new LinkedHashSet<>(values)));
  }

  static List<String> inverse(List<String> excluded) {
    Set<String> exclude = new LinkedHashSet<>(excluded);
    List<String> out = new ArrayList<>();
    for (String ch : PRINTABLE_ASCII) {
      if (!exclude.contains(ch)) {
        out.add(ch);
      }
    }
    return out;
  }
}
