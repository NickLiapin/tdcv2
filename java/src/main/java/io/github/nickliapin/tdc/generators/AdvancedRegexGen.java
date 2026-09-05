package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.distribution.Hamilton;
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
 * {@code <gen type="advanced_regex" .../>} — the same finite subset, plus exact shares.
 *
 * <pre>{@code (?%{70:RU;20:US;10:DE})}</pre>
 *
 * <p>Seventy per cent of the column reads {@code RU}, exactly — not "seventy per cent on
 * average". Branches are themselves full patterns, so a weighted choice can hold a weighted
 * choice.
 *
 * <p>It lives beside the plain {@code regex} generator rather than inside it, because an exact
 * share is only meaningful over a whole column. That forces a different way of generating:
 * every row is built <b>together</b>, level by level, with rows bucketed by the branch they were
 * assigned. The plain generator builds one value at a time and never has to know how many rows
 * there are.
 *
 * <p>A consequence worth stating: the two dialects consume the generator in different orders, so
 * the same pattern produces different data under {@code regex} and {@code advanced_regex}. That
 * is not a defect to be reconciled — it follows from what an exact share requires.
 */
public final class AdvancedRegexGen {

  /** Inside a weighted branch these end it, on top of the usual {@code )} and {@code |}. */
  private static final Set<String> BRANCH_STOP = Set.of(";", "}");

  public sealed interface Node {}

  record Empty() implements Node {}

  record Literal(String value) implements Node {}

  record Chars(List<String> chars) implements Node {}

  record Sequence(List<Node> parts) implements Node {}

  record Alternation(List<Node> choices) implements Node {}

  record Repeat(Node node, int min, int max) implements Node {}

  record Capture(int index, Node node, long maxLength) implements Node {}

  record Backref(int index) implements Node {}

  record Branch(double percent, Node node) {}

  record Weighted(List<Branch> choices) implements Node {}

  /**
   * One branch of {@code (?if{…})}.
   *
   * <p>{@code test} is null for the {@code *} branch, which always matches; otherwise it is the
   * capture index to read and the text it must equal.
   */
  record CondBranch(CondTest test, Node node) {}

  record CondTest(int capture, String value) {}

  /**
   * {@code (?if{sex=male:MR;sex=female:MS})} — pick a branch from what an EARLIER named group
   * produced on this row.
   *
   * <p>The one construct here that reads rather than draws. Everything else decides a row from
   * randomness alone, which is why a pattern could describe an address or an identifier but never
   * a title that agrees with a sex chosen two characters earlier.
   *
   * <p>Branches are tried in the order written and the first match wins, so a {@code *} is an
   * "otherwise" wherever it stands — and a row matching NO branch produces nothing at all, which
   * is what {@code *} exists to prevent.
   */
  record Conditional(List<CondBranch> branches) implements Node {}

  /** One row under construction: what it has so far, and what its groups captured. */
  private static final class RowState {
    final StringBuilder out = new StringBuilder();
    final Map<Integer, String> captures = new HashMap<>();
  }

  private AdvancedRegexGen() {}

  public static List<String> generate(
      Map<String, String> attrs, int count, int documentMaxLength, Prng.Sfc32 prng) {
    int limit =
        attrs.get("regex_max_length") != null
            ? RegexGen.parseMaxLength(attrs.get("regex_max_length"))
            : documentMaxLength;
    Node root = compile(attrs.getOrDefault("value", ""), limit);

    List<RowState> rows = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      rows.add(new RowState());
    }
    generateInto(root, rows, prng);

    List<String> out = new ArrayList<>(count);
    for (RowState row : rows) {
      out.add(row.out.toString());
    }
    return out;
  }

  public static Node compile(String pattern, int regexMaxLength) {
    Parser parser = new Parser(pattern);
    Node root = parser.parse();
    long maxLength = maxLength(root, parser.captureMaxLengths);
    if (maxLength > regexMaxLength) {
      throw new IllegalArgumentException(
          "advanced_regex can produce "
              + maxLength
              + " characters, which exceeds regex_max_length="
              + regexMaxLength);
    }
    return root;
  }

  /** Whether a pattern uses a weighted choice — the thing that needs a whole column at once. */
  public static boolean hasWeightedChoice(String pattern) {
    try {
      Parser parser = new Parser(pattern);
      parser.parse();
      return parser.weightedChoiceCount > 0;
    } catch (RuntimeException e) {
      // A malformed pattern is not this question's business; the real parse error surfaces when
      // the generator runs.
      return false;
    }
  }

  // ── generating, a level at a time across every row ───────────────────────────────────────

  private static void generateInto(Node node, List<RowState> rows, Prng.Sfc32 prng) {
    if (rows.isEmpty()) {
      return;
    }
    if (node instanceof Empty) {
      return;
    }
    if (node instanceof Literal l) {
      for (RowState row : rows) {
        row.out.append(l.value());
      }
      return;
    }
    if (node instanceof Chars c) {
      for (RowState row : rows) {
        row.out.append(Random.pick(prng, c.chars()));
      }
      return;
    }
    if (node instanceof Sequence s) {
      for (Node part : s.parts()) {
        generateInto(part, rows, prng);
      }
      return;
    }
    if (node instanceof Alternation a) {
      // Assign every row a branch first, then run each branch once over its own rows.
      List<List<RowState>> buckets = buckets(a.choices().size());
      for (RowState row : rows) {
        buckets.get(Random.nextInt(prng, 0, a.choices().size())).add(row);
      }
      for (int i = 0; i < a.choices().size(); i++) {
        if (!buckets.get(i).isEmpty()) {
          generateInto(a.choices().get(i), buckets.get(i), prng);
        }
      }
      return;
    }
    if (node instanceof Repeat r) {
      int[] counts = new int[rows.size()];
      for (int i = 0; i < rows.size(); i++) {
        counts[i] = Random.nextInt(prng, r.min(), r.max() + 1);
      }
      // One pass per repetition, over the rows still repeating — so every row's first
      // repetition is drawn before any row's second.
      for (int step = 0; step < r.max(); step++) {
        List<RowState> active = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
          if (counts[i] > step) {
            active.add(rows.get(i));
          }
        }
        generateInto(r.node(), active, prng);
      }
      return;
    }
    if (node instanceof Capture c) {
      int[] starts = new int[rows.size()];
      for (int i = 0; i < rows.size(); i++) {
        starts[i] = rows.get(i).out.length();
      }
      generateInto(c.node(), rows, prng);
      for (int i = 0; i < rows.size(); i++) {
        rows.get(i).captures.put(c.index(), rows.get(i).out.substring(starts[i]));
      }
      return;
    }
    if (node instanceof Backref b) {
      for (RowState row : rows) {
        row.out.append(row.captures.getOrDefault(b.index(), ""));
      }
      return;
    }
    if (node instanceof Weighted w) {
      // The reason this generator exists: an exact apportionment over the column, the same
      // Hamilton machinery percent= uses, rather than an independent draw per row.
      List<Integer> indexes = new ArrayList<>();
      double[] percents = new double[w.choices().size()];
      for (int i = 0; i < w.choices().size(); i++) {
        indexes.add(i);
        percents[i] = w.choices().get(i).percent();
      }
      List<Integer> selected = Hamilton.distribute(rows.size(), indexes, percents, prng);
      List<List<RowState>> buckets = buckets(w.choices().size());
      for (int i = 0; i < rows.size(); i++) {
        buckets.get(selected.get(i)).add(rows.get(i));
      }
      for (int i = 0; i < w.choices().size(); i++) {
        if (!buckets.get(i).isEmpty()) {
          generateInto(w.choices().get(i).node(), buckets.get(i), prng);
        }
      }
      return;
    }
    if (node instanceof Conditional c) {
      // Each row to the FIRST branch it passes, then the branches in the order written. Rows
      // that pass no branch are left untouched — nothing is appended — which is the only honest
      // answer when the pattern says nothing about the value the row actually holds.
      List<List<RowState>> buckets = buckets(c.branches().size());
      for (RowState row : rows) {
        for (int i = 0; i < c.branches().size(); i++) {
          CondTest test = c.branches().get(i).test();
          if (test == null
              || test.value().equals(row.captures.getOrDefault(test.capture(), ""))) {
            buckets.get(i).add(row);
            break;
          }
        }
      }
      for (int i = 0; i < c.branches().size(); i++) {
        if (!buckets.get(i).isEmpty()) {
          generateInto(c.branches().get(i).node(), buckets.get(i), prng);
        }
      }
      return;
    }
    throw new IllegalStateException("advanced_regex: unhandled node " + node);
  }

  private static List<List<RowState>> buckets(int size) {
    List<List<RowState>> out = new ArrayList<>(size);
    for (int i = 0; i < size; i++) {
      out.add(new ArrayList<>());
    }
    return out;
  }

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
    if (node instanceof Weighted w) {
      long best = 0;
      for (Branch branch : w.choices()) {
        best = Math.max(best, maxLength(branch.node(), captureMaxLengths));
      }
      return best;
    }
    if (node instanceof Conditional c) {
      // The longest branch: a row takes exactly one of them, so the widest the conditional can
      // be is the widest branch — never their sum.
      long best = 0;
      for (CondBranch branch : c.branches()) {
        best = Math.max(best, maxLength(branch.node(), captureMaxLengths));
      }
      return best;
    }
    throw new IllegalStateException("advanced_regex: unhandled node " + node);
  }

  private static long guard(long value) {
    if (value < 0 || value > Integer.MAX_VALUE) {
      throw new IllegalArgumentException("advanced_regex: maximum length is too large");
    }
    return value;
  }

  // ── parsing ──────────────────────────────────────────────────────────────────────────────

  static final class Parser {
    private final String pattern;
    private int pos;
    private int captureCount;
    private int closedCaptureCount;
    int weightedChoiceCount;
    final Map<Integer, Long> captureMaxLengths = new HashMap<>();
    /**
     * {@code (?<name>…)} → its capture index, filled as each named group CLOSES.
     *
     * <p>Closing rather than opening, so {@code (?<a>(?if{a=x:y}))} cannot read the group it is
     * inside: at that point the group has produced nothing, and the condition would compare
     * against the empty string on every row.
     */
    private final Map<String, Integer> groupNames = new HashMap<>();

    Parser(String pattern) {
      this.pattern = pattern;
    }

    Node parse() {
      Node node = alternation(Set.of());
      if (!atEnd()) {
        throw error("unexpected \"" + peek() + "\"");
      }
      return node;
    }

    private Node alternation(Set<String> stop) {
      List<Node> choices = new ArrayList<>();
      choices.add(sequence(stop));
      while ("|".equals(peek())) {
        pos++;
        choices.add(sequence(stop));
      }
      return choices.size() == 1 ? choices.get(0) : new Alternation(List.copyOf(choices));
    }

    private Node sequence(Set<String> stop) {
      List<Node> parts = new ArrayList<>();
      while (!atEnd()) {
        String ch = peek();
        if (")".equals(ch) || "|".equals(ch) || stop.contains(ch)) {
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
          return chars(RegexGen.PRINTABLE_ASCII);
        case "^":
        case "$":
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
      if ("?".equals(peek()) && pattern.startsWith("?%{", pos)) {
        pos += 3;
        Node node = weightedChoice();
        expect(")");
        return node;
      }
      if ("?".equals(peek()) && pattern.startsWith("?if{", pos)) {
        pos += 4;
        Node node = conditional();
        expect(")");
        return node;
      }

      boolean capturing = true;
      String name = null;
      if ("?".equals(peek())) {
        if (pattern.startsWith("?:", pos)) {
          pos += 2;
          capturing = false;
        } else if (pattern.startsWith("?<", pos) && !isLookbehind()) {
          pos += 2;
          name = groupName();
        } else {
          throw error(
              "this group is not supported — advanced_regex has (?:…), (?<name>…), (?%{…}) "
                  + "and (?if{…}). Lookaround and numbered conditionals decide what a pattern "
                  + "MATCHES, and nothing here is matching anything");
        }
      }

      int index = 0;
      if (capturing) {
        index = ++captureCount;
      }
      Node node = alternation(Set.of());
      expect(")");
      if (!capturing) {
        return node;
      }
      closedCaptureCount = Math.max(closedCaptureCount, index);
      long groupMax = maxLength(node, captureMaxLengths);
      captureMaxLengths.put(index, groupMax);
      if (name != null) {
        groupNames.put(name, index);
      }
      return new Capture(index, node, groupMax);
    }

    /** {@code (?<=…)} and {@code (?<!…)} are LOOKBEHIND, not a group called "=" or "!". */
    private boolean isLookbehind() {
      char after = pos + 2 < pattern.length() ? pattern.charAt(pos + 2) : ' ';
      return after == '=' || after == '!';
    }

    /** The {@code name} of {@code (?<name>…)}, up to the closing {@code >}. */
    private String groupName() {
      int start = pos;
      while (!atEnd() && !">".equals(peek())) {
        pos++;
      }
      String name = pattern.substring(start, pos);
      expect(">");
      if (name.isEmpty()) {
        throw error("a named group needs a name: (?<sex>…)");
      }
      if (!name.matches("[A-Za-z_][A-Za-z0-9_]*")) {
        throw error(
            "group name \"" + name + "\" must start with a letter or \"_\" and hold only "
                + "letters, digits and \"_\"");
      }
      // Two groups under one name would make `(?if{name=…})` a coin toss between them, decided
      // by whichever the parser happened to record last.
      if (groupNames.containsKey(name)) {
        throw error("group name \"" + name + "\" is already used");
      }
      return name;
    }

    /**
     * {@code ?if{sex=male:MR;sex=female:MS}} — the {@code (?if{} is already consumed.
     *
     * <p>Each branch is a full pattern, so weighted choices and further conditionals nest inside
     * them exactly as they do inside a weighted branch.
     */
    private Node conditional() {
      List<CondBranch> branches = new ArrayList<>();
      while (!atEnd()) {
        skipSpaces();
        if ("}".equals(peek())) {
          throw error("conditional must contain at least one branch");
        }
        CondTest test = conditionalTest();
        Node node = alternation(BRANCH_STOP);
        branches.add(new CondBranch(test, node));

        String ch = peek();
        if (";".equals(ch)) {
          pos++;
          continue;
        }
        if ("}".equals(ch)) {
          pos++;
          return new Conditional(branches);
        }
        throw error("expected \";\" or \"}\" in conditional");
      }
      throw error("unterminated conditional");
    }

    /** {@code name=value} before a branch's {@code :}, or {@code *} for the branch that always matches. */
    private CondTest conditionalTest() {
      int start = pos;
      while (!atEnd() && !":".equals(peek()) && !"}".equals(peek())) {
        pos++;
      }
      String raw = pattern.substring(start, pos);
      expect(":");
      if ("*".equals(raw)) {
        return null;
      }
      int split = raw.indexOf('=');
      if (split < 0) {
        throw error(
            "conditional branch \"" + raw + "\" must read a group: name=value, or \"*\" for "
                + "every other row");
      }
      String name = raw.substring(0, split).trim();
      Integer capture = groupNames.get(name);
      if (capture == null) {
        // Declared LATER is the same as not declared at all here: the pattern is generated left
        // to right, so a group further along has produced nothing to compare against and the
        // branch could never be taken.
        throw error(
            "conditional reads \"" + name + "\", which no (?<" + name + ">…) group before it "
                + "declares");
      }
      return new CondTest(capture, raw.substring(split + 1));
    }

    private Node weightedChoice() {
      List<Branch> choices = new ArrayList<>();
      while (!atEnd()) {
        skipSpaces();
        if ("}".equals(peek())) {
          throw error("weighted choice must contain at least one branch");
        }
        double percent = weight();
        skipSpaces();
        expect(":");
        Node node = alternation(BRANCH_STOP);
        choices.add(new Branch(percent, node));

        String ch = peek();
        if (";".equals(ch)) {
          pos++;
          continue;
        }
        if ("}".equals(ch)) {
          pos++;
          double sum = 0;
          for (Branch branch : choices) {
            sum += branch.percent();
          }
          if (Math.abs(sum - 100) > 0.0001) {
            // Through the shared number-to-text, not Java's own: `String.valueOf(70.0)` prints
            // the trailing `.0`, so the refusal said the pattern asks for `70.0` where it asks
            // for `70` — the number in a message about a number has to be the one that was
            // written.
            throw error(
                "weighted choice percentages sum to "
                    + io.github.nickliapin.tdc.lib.Numbers.toText(sum)
                    + ", expected 100");
          }
          weightedChoiceCount++;
          return new Weighted(List.copyOf(choices));
        }
        throw error("expected \";\" or \"}\" in weighted choice");
      }
      throw error("unterminated weighted choice");
    }

    private double weight() {
      int start = pos;
      while (!atEnd() && (RegexGen.isDigit(peek()) || ".".equals(peek()))) {
        pos++;
      }
      String raw = pattern.substring(start, pos);
      double value;
      try {
        value = Double.parseDouble(raw);
      } catch (NumberFormatException e) {
        throw error("invalid weighted choice percent \"" + raw + "\"");
      }
      if (raw.isEmpty() || !Double.isFinite(value) || value < 0) {
        throw error("invalid weighted choice percent \"" + raw + "\"");
      }
      return value;
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
        for (String ch : RegexGen.PRINTABLE_ASCII) {
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
          return new ClassAtom(RegexGen.DIGITS, null);
        case "D":
          return new ClassAtom(RegexGen.inverse(RegexGen.DIGITS), null);
        case "w":
          return new ClassAtom(RegexGen.WORD, null);
        case "W":
          return new ClassAtom(RegexGen.inverse(RegexGen.WORD), null);
        case "s":
          return new ClassAtom(RegexGen.SPACES, null);
        case "S":
          return new ClassAtom(RegexGen.inverse(RegexGen.SPACES), null);
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
      if (RegexGen.isDigit(ch)) {
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
          return chars(RegexGen.DIGITS);
        case "D":
          return chars(RegexGen.inverse(RegexGen.DIGITS));
        case "w":
          return chars(RegexGen.WORD);
        case "W":
          return chars(RegexGen.inverse(RegexGen.WORD));
        case "s":
          return chars(RegexGen.SPACES);
        case "S":
          return chars(RegexGen.inverse(RegexGen.SPACES));
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
      while (!atEnd() && RegexGen.isDigit(peek())) {
        out.append(peek());
        pos++;
      }
      return out.toString();
    }

    private void skipSpaces() {
      while (" ".equals(peek()) || "\t".equals(peek())) {
        pos++;
      }
    }

    private void expect(String expected) {
      String actual = peek();
      if (!expected.equals(actual)) {
        throw error(
            "expected \""
                + expected
                + "\" but found \""
                + (actual == null ? "end of pattern" : actual)
                + "\"");
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
      return new IllegalArgumentException("advanced_regex: " + message + " at offset " + pos);
    }
  }

  private static Node chars(List<String> values) {
    return new Chars(List.copyOf(new LinkedHashSet<>(values)));
  }
}
