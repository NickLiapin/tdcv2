package io.github.nickliapin.tdc.validator;

import io.github.nickliapin.tdc.errors.Diagnostic;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The {@code <compute>} tree, checked before it runs.
 *
 * <p>Compute is a small language of its own, and its mistakes are the quiet kind: a
 * {@code <var>} nobody bound reads as empty, a {@code <choose>} with no fallback produces nothing
 * when every branch misses, a second {@code <result>} silently wins over the first. None of that
 * stops a run — it produces a check digit that is wrong, in a file of a million records that all
 * look plausible.
 *
 * <p>So the whole tree is walked here: unknown tags, bindings, arity, encodings, and the wrapper
 * children each construct needs. Diagnostics TDC180 through TDC189.
 */
final class ComputeCheck {

  private static final Set<String> ENCODINGS =
      Set.of("base36", "ascii", "unicode", "hex", "binary", "octal");
  /**
   * The four tags that answer TRUE or FALSE rather than producing a value.
   *
   * <p>They are compute tags, so the unknown-tag check waves them through wherever they
   * appear; this set is what keeps a predicate out of a value position, where the evaluator's
   * own complaint arrived only at render time and named no file, line or code.
   */
  private static final java.util.Set<String> PREDICATE_TAGS =
      java.util.Set.of("equals", "greater_than", "less_than", "is_digit");


  private static final Set<String> KNOWN_TAGS =
      Set.of(
          // literals and references
          "int", "str", "list", "field", "var", "current", "current_index", "acc",
          // binding
          "let",
          // collections
          "each", "reduce", "join", "split", "at", "length",
          // arithmetic
          "add", "subtract", "multiply", "divide", "mod",
          // encoding and conversion
          "encode", "to_number", "pad", "concat", "upper", "lower", "capitalize", "title",
          "mask", "slice", "replace", "trim", "group",
          // conditionals and the role wrappers
          "choose", "when", "otherwise", "test", "then", "result", "over", "do", "init", "in",
          "index",
          // predicates
          "equals", "greater_than", "less_than", "is_digit");

  /**
   * Tags the compute spec describes but this version does not ship, so the diagnostic explains
   * the gap instead of reading like a typo.
   */
  private static final Map<String, String> HINTS_BY_TAG =
      Map.of(
          "param",
          "<param> belongs to the compute-def/use feature, which is not implemented yet. "
              + "An inline <compute> takes no parameters — read the value with <field name=\"…\"/> instead.");

  /** One node of the tree, flattened out of the two shapes the grammar produces. */
  private record Node(
      String name, Map<String, String> attrs, List<TDCParser.ElementContext> children, int line,
      int column) {}

  /** What is visible where: the bound variables, and which bodies we are inside. */
  private record Scope(Set<String> vars, boolean inIteration, boolean inReduce, Set<String> knownFields) {

    Scope withVars(Set<String> newVars) {
      return new Scope(newVars, inIteration, inReduce, knownFields);
    }

    Scope iterating(boolean reduce) {
      return new Scope(vars, true, reduce || inReduce, knownFields);
    }
  }

  private final List<Diagnostic> diagnostics;

  ComputeCheck(List<Diagnostic> diagnostics) {
    this.diagnostics = diagnostics;
  }

  /**
   * Check one {@code <compute>}.
   *
   * @param knownFields the names {@code <field>} may read, or {@code null} when the caller does
   *     not know them — a pack generator's body is checked without the run's sequences in view.
   */
  void check(TDCParser.OpenCloseElementContext computeEl, Set<String> knownFields) {
    Scope scope = new Scope(Set.of(), false, false, knownFields);

    // Documented as "at most once". A second one silently wins and the first is discarded, so a
    // config can compute something entirely different from what its author read top to bottom.
    boolean seenResult = false;
    for (TDCParser.ElementContext child : computeEl.content().element()) {
      Node node = node(child);
      if (node == null || !"result".equals(node.name())) {
        continue;
      }
      if (seenResult) {
        report(node, "TDC189", "<compute> has more than one <result>",
            "Only the last one would be used and the earlier ones silently dropped. "
                + "Keep a single <result>.");
      }
      seenResult = true;
    }

    walkSlot(computeEl.content().element(), scope);
  }

  /**
   * A slot: {@code <let>} prefixes bind for the siblings after them, and the last child is the
   * value.
   */
  private void walkSlot(List<TDCParser.ElementContext> children, Scope scope) {
    Set<String> bound = new LinkedHashSet<>(scope.vars());
    for (TDCParser.ElementContext child : children) {
      Node node = node(child);
      if (node == null) {
        continue;
      }
      if ("let".equals(node.name())) {
        String name = node.attrs().getOrDefault("name", "");
        if (bound.contains(name)) {
          report(node, "TDC185",
              "<let name=\"" + name + "\"> shadows an outer binding of the same name", null);
        }
        walkSlot(node.children(), scope.withVars(new LinkedHashSet<>(bound)));
        bound.add(name);
      } else {
        walkExpr(child, scope.withVars(new LinkedHashSet<>(bound)));
      }
    }
  }

  /** A construct that needs one named wrapper child, like {@code <each><over>…</over></each>}. */
  private void walkWrapper(Node node, String wrapper, Scope scope) {
    for (TDCParser.ElementContext child : node.children()) {
      Node inner = node(child);
      if (inner != null && wrapper.equals(inner.name())) {
        walkSlot(inner.children(), scope);
        return;
      }
    }
    report(node, "TDC187", "<" + node.name() + "> requires a <" + wrapper + "> child", null);
  }

  private void walkExpr(TDCParser.ElementContext element, Scope scope) {
    Node node = node(element);
    if (node == null) {
      return;
    }
    // A predicate answers TRUE or FALSE, so it is not a value. It is a compute tag, so the
    // unknown-tag check below waves it through wherever it appears — and
    // <result><greater_than>…</greater_than></result> then passed check and died mid-run with
    // a message carrying no code, no line and no file.
    if (PREDICATE_TAGS.contains(node.name())) {
      report(node, "TDC180",
          "<" + node.name() + "> is a predicate, not a value — it is valid only inside <test>",
          "A predicate answers true or false, and this position wants something to print. "
              + "Wrap it: <choose><when><test><" + node.name() + ">…</" + node.name()
              + "></test></when><then>…</then></choose>.");
      return;
    }
    if (!KNOWN_TAGS.contains(node.name())) {
      report(node, "TDC180", "unknown compute tag <" + node.name() + ">",
          HINTS_BY_TAG.get(node.name()));
      return;
    }

    switch (node.name()) {
      case "current", "current_index" -> {
        if (!scope.inIteration()) {
          report(node, "TDC181",
              "<" + node.name() + "/> is only valid inside a <do> iteration body", null);
        }
      }
      case "acc" -> {
        if (!scope.inReduce()) {
          report(node, "TDC181", "<acc/> is only valid inside a <reduce> <do> body", null);
        }
      }
      case "var" -> {
        String name = node.attrs().getOrDefault("name", "");
        if (!scope.vars().contains(name)) {
          report(node, "TDC182", "<var name=\"" + name + "\"> is not bound by an enclosing <let>",
              null);
        }
      }
      case "field" -> {
        String name = node.attrs().getOrDefault("name", "");
        if (scope.knownFields() != null && !scope.knownFields().contains(name)) {
          report(node, "TDC182",
              "<field name=\"" + name + "\"> refers to a value that is not in scope", null);
        }
      }
      case "int" -> {
        String raw = node.attrs().getOrDefault("v", "").trim();
        if (!raw.matches("^-?\\d+$")) {
          report(node, "TDC188",
              "<int v=\"" + node.attrs().getOrDefault("v", "") + "\"> is not an integer",
              "Write a whole number, e.g. <int v=\"42\"/>. For text use <str v=\"…\"/>.");
        }
      }
      case "str" -> {
        // A literal string: nothing about it can be wrong here.
      }
      case "group" -> {
        // A size the engine cannot use turns grouping OFF and says nothing, so the column comes
        // out looking like the tag was never written. size="2.5" is worse: measured "12 34 567",
        // grouped by neither 2 nor 3.
        String size = node.attrs().get("size");
        if (size != null && !size.trim().matches("[1-9][0-9]*")) {
          report(node, "TDC188",
              "<group size=\"" + size.trim() + "\"> is not a whole number of characters",
              "Write a positive whole number. A size the engine cannot use would turn grouping off and leave the value unchanged, with nothing to show why.");
        }
        walkSlot(node.children(), scope);
      }
      case "list", "add", "multiply", "concat" -> {
        // <list> has two spellings and reads only the first: with v= set the children are never
        // evaluated, so writing both keeps whichever the author was not looking at.
        if ("list".equals(node.name()) && node.attrs().get("v") != null && hasElementChild(node)) {
          report(node, "TDC189", "<list> has both v= and children", "Only v= is read; the children are silently dropped. Keep one spelling: v=\"1,2,3\" for a literal list, or child elements for a computed one.");
        }
        for (TDCParser.ElementContext child : node.children()) {
          walkExpr(child, scope);
        }
      }
      case "mod", "divide" -> {
        int count = countNodes(node);
        if (count != 2) {
          report(node, "TDC183",
              "<" + node.name() + "> requires exactly 2 children, found " + count, null);
        }
        for (TDCParser.ElementContext child : node.children()) {
          walkExpr(child, scope);
        }
      }
      case "subtract" -> {
        if (countNodes(node) < 1) {
          report(node, "TDC183", "<subtract> requires at least one child", null);
        }
        for (TDCParser.ElementContext child : node.children()) {
          walkExpr(child, scope);
        }
      }
      case "each" -> {
        checkSlotNames(node, "over", "do");
        walkWrapper(node, "over", scope);
        walkWrapper(node, "do", scope.iterating(false));
      }
      case "reduce" -> {
        checkSlotNames(node, "over", "init", "do");
        walkWrapper(node, "over", scope);
        walkWrapper(node, "init", scope);
        walkWrapper(node, "do", scope.iterating(true));
      }
      case "at" -> {
        checkSlotNames(node, "in", "index");
        walkWrapper(node, "in", scope);
        walkWrapper(node, "index", scope);
      }
      case "mask" -> {
        // The filter form of the same fault is TDC256 in Validator. A mask with no pattern has
        // nothing to keep, and the engine answered that literally: it returned the empty string.
        if (node.attrs().getOrDefault("pattern", "").trim().isEmpty()) {
          report(node, "TDC256",
              "<mask> needs a pattern= — without one it returns the empty string", null);
        }
        walkSlot(node.children(), scope);
      }
      case "encode" -> {
        String as = node.attrs().getOrDefault("as", "");
        if (!ENCODINGS.contains(as)) {
          report(node, "TDC186", "<encode>: unknown encoding \"" + as + "\"", null);
        }
        walkSlot(node.children(), scope);
      }
      case "choose" -> walkChoose(node, scope);
      case "over" -> report(node, "TDC181", "<over> is only valid inside <each> or <reduce>",
          "It names the list being walked. Outside those tags there is nothing to walk.");
      default -> walkSlot(node.children(), scope);
    }
  }

  /**
   * A child in a SLOT position that names no slot this tag has.
   *
   * <p>{@code <choose>}, {@code <when>}, {@code <each>}, {@code <reduce>} and {@code <at>} do not
   * evaluate their children in order — each looks up the slots it knows by name and ignores
   * everything else. So a misspelled slot name was never walked, never validated, and never run.
   * Measured on the compute overview's own Luhn example with {@code <when>} spelled {@code <wen>}:
   * the {@code <otherwise>} won every row and every card number came out invalid, while
   * {@code check} called the config valid.
   *
   * <p>The stray part is deliberately NOT walked: what the author meant is unknown, so every rule
   * applied inside is a guess about the intended shape.
   */
  private boolean hasElementChild(Node node) {
    for (TDCParser.ElementContext child : node.children()) {
      if (node(child) != null) {
        return true;
      }
    }
    return false;
  }

  private void checkSlotNames(Node node, String... slots) {
    java.util.Set<String> known = java.util.Set.of(slots);
    for (TDCParser.ElementContext child : node.children()) {
      Node inner = node(child);
      if (inner == null || known.contains(inner.name())) {
        continue;
      }
      StringBuilder allowed = new StringBuilder();
      for (int i = 0; i < slots.length; i++) {
        if (i > 0) {
          allowed.append(" and ");
        }
        allowed.append('<').append(slots[i]).append('>');
      }
      report(
          inner,
          "TDC180",
          "<" + node.name() + "> has no <" + inner.name() + "> part",
          "Inside <" + node.name() + "> only " + allowed
              + " are read; anything else is silently ignored, so a misspelling here changes the"
              + " result without any other sign.");
    }
  }

  private void walkChoose(Node node, Scope scope) {
    checkSlotNames(node, "when", "otherwise");
    boolean hasOtherwise = false;
    for (TDCParser.ElementContext child : node.children()) {
      Node inner = node(child);
      if (inner == null) {
        continue;
      }
      if ("when".equals(inner.name())) {
        walkWhen(inner, scope);
      } else if ("otherwise".equals(inner.name())) {
        hasOtherwise = true;
        walkSlot(inner.children(), scope);
      }
    }
    if (!hasOtherwise) {
      // Without it, a row matching no branch computes nothing at all — and an empty check digit
      // is indistinguishable from a value that happens to be blank.
      report(node, "TDC184", "<choose> requires an <otherwise> branch", null);
    }
  }

  private void walkWhen(Node node, Scope scope) {
    checkSlotNames(node, "test", "then");
    Node test = null;
    for (TDCParser.ElementContext child : node.children()) {
      Node inner = node(child);
      if (inner != null && "test".equals(inner.name())) {
        test = inner;
        break;
      }
    }
    if (test == null) {
      report(node, "TDC187", "<when> requires a <test> child", null);
    } else {
      for (TDCParser.ElementContext child : test.children()) {
        Node predicate = node(child);
        if (predicate != null) {
          walkPredicate(predicate, scope);
          break;
        }
      }
    }
    walkWrapper(node, "then", scope);
  }

  private void walkPredicate(Node node, Scope scope) {
    switch (node.name()) {
      case "equals", "greater_than", "less_than" -> {
        if (countNodes(node) != 2) {
          report(node, "TDC183", "<" + node.name() + "> requires exactly 2 children", null);
        }
        for (TDCParser.ElementContext child : node.children()) {
          walkExpr(child, scope);
        }
      }
      case "is_digit" -> {
        for (TDCParser.ElementContext child : node.children()) {
          walkExpr(child, scope);
        }
      }
      default -> report(node, "TDC180",
          "unknown predicate <" + node.name() + "> (valid only inside <test>)", null);
    }
  }

  // ── plumbing ─────────────────────────────────────────────────────────────────────────────

  private static Node node(TDCParser.ElementContext element) {
    TDCParser.OpenCloseElementContext open = element.openCloseElement();
    if (open != null) {
      return new Node(
          open.name.getText(),
          attributes(open.attr()),
          open.content().element(),
          open.getStart().getLine(),
          open.getStart().getCharPositionInLine());
    }
    TDCParser.SelfClosingElementContext self = element.selfClosingElement();
    if (self != null) {
      return new Node(
          self.name.getText(),
          attributes(self.attr()),
          List.of(),
          self.getStart().getLine(),
          self.getStart().getCharPositionInLine());
    }
    return null; // a <data> body, which carries no compute node
  }

  /** How many of a node's children are elements — a text body is not an argument. */
  private static int countNodes(Node node) {
    int count = 0;
    for (TDCParser.ElementContext child : node.children()) {
      if (node(child) != null) {
        count++;
      }
    }
    return count;
  }

  private static Map<String, String> attributes(List<TDCParser.AttrContext> attrs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (TDCParser.AttrContext attr : attrs) {
      String raw = attr.attrValue.getText();
      out.put(attr.attrName.getText(), raw.substring(1, raw.length() - 1));
    }
    return out;
  }

  private void report(Node node, String code, String message, String hint) {
    diagnostics.add(
        Diagnostic.error(code, message, hint == null ? "" : hint, node.line(), node.column()));
  }

  /** The compute nodes a document holds, for a caller that wants to walk them itself. */
  static List<TDCParser.OpenCloseElementContext> computeElements(
      TDCParser.OpenCloseElementContext parent) {
    List<TDCParser.OpenCloseElementContext> out = new ArrayList<>();
    for (TDCParser.ElementContext child : parent.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && "compute".equals(open.name.getText())) {
        out.add(open);
      }
    }
    return out;
  }
}
