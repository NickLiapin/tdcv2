package io.github.nickliapin.tdc.compute;

import io.github.nickliapin.tdc.format.Mask;
import io.github.nickliapin.tdc.format.Transforms;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * The {@code <compute>} layer — a declarative little language for check digits.
 *
 * <p>Real identifiers are not random strings. A tax number, an IBAN, a national ID: each carries
 * a check digit computed from the rest of itself, and a generated one without it is rejected by
 * the very system it was generated to test. This is what makes the difference between data that
 * merely looks right and data that passes validation.
 *
 * <p>It is a language rather than a list of built-in algorithms because there is no such list.
 * Every country invented its own weighting, and a data pack that can express the rule can add a
 * country without touching the engine — which is exactly how the bundled packs do it.
 *
 * <p>The parse tree is the syntax tree: the evaluator walks the ANTLR contexts directly. That is
 * not a shortcut, it is the portability contract — every implementation walks the same shape, so
 * there is no expression grammar for anyone to re-implement slightly differently.
 *
 * <p>Pure: no clock, no randomness, no files. Its only inputs are the fields visible to it.
 */
public final class Compute {

  /** What an evaluation can see: the sequence values in scope, by name. */
  public interface Fields {
    String get(String name);
  }

  /** Bindings and the contextual values that exist only inside an iteration. */
  private record Scope(
      Fields fields, Map<String, Value> vars, Value current, BigInteger currentIndex, Value acc) {

    Scope withVar(String name, Value value) {
      Map<String, Value> next = new HashMap<>(vars);
      next.put(name, value);
      // The whole scope carries over: a <let> inside an iteration must not drop current/acc.
      return new Scope(fields, next, current, currentIndex, acc);
    }

    Scope withIteration(Value item, BigInteger index, Value accumulator) {
      return new Scope(fields, vars, item, index, accumulator);
    }
  }

  /** A normalised view of one element: its name, attributes and element children. */
  private record Node(String name, Map<String, String> attrs, List<TDCParser.ElementContext> children) {}

  private Compute() {}

  /** Evaluate a {@code <compute>} element to its output string. */
  public static String evaluate(TDCParser.OpenCloseElementContext computeEl, Fields fields) {
    Scope scope = new Scope(fields, Map.of(), null, null, null);
    return Value.toOutput(evalSlot(elements(computeEl.content()), scope));
  }

  /**
   * Evaluate a {@code <valid>} element's predicate.
   *
   * <p>Some identifiers have combinations that are structurally impossible — a date that does not
   * exist inside a national ID, a region code that was never issued. A pack draws again rather
   * than emitting one.
   */
  public static boolean evaluatePredicate(TDCParser.OpenCloseElementContext validEl, Fields fields) {
    Scope scope = new Scope(fields, Map.of(), null, null, null);
    for (TDCParser.ElementContext child : elements(validEl.content())) {
      if (!nodeName(child).isEmpty()) {
        return evalPredicate(child, scope);
      }
    }
    throw new ComputeError("<valid> requires a predicate child");
  }

  // ── slots ────────────────────────────────────────────────────────────────────────────────

  /**
   * A slot: any number of {@code <let>} bindings followed by exactly one value expression.
   *
   * <p>Bindings accumulate, so a later {@code <let>} and the final expression both see the
   * earlier ones — which is what lets a long check-digit computation be written as a series of
   * named steps instead of one unreadable nest.
   */
  private static Value evalSlot(List<TDCParser.ElementContext> children, Scope scope) {
    Scope local = scope;
    Value result = null;
    for (TDCParser.ElementContext child : children) {
      if ("let".equals(nodeName(child))) {
        Node n = node(child);
        local = local.withVar(n.attrs().getOrDefault("name", ""), evalSlot(n.children(), local));
      } else {
        result = eval(child, local);
      }
    }
    if (result == null) {
      throw new ComputeError("empty expression slot: no value produced");
    }
    return result;
  }

  private static Value evalWrapper(Node n, String wrapper, Scope scope) {
    return evalSlot(requireChild(n, wrapper).children(), scope);
  }

  // ── the evaluator ────────────────────────────────────────────────────────────────────────

  private static Value eval(TDCParser.ElementContext el, Scope scope) {
    Node n = node(el);
    switch (n.name()) {
      // literals
      case "int": {
        String raw = n.attrs().getOrDefault("v", "");
        if (!raw.matches("^-?[0-9]+$")) {
          throw new ComputeError("<int>: \"" + raw + "\" is not an integer");
        }
        return Value.of(new BigInteger(raw));
      }
      case "str":
        return Value.of(n.attrs().getOrDefault("v", ""));
      case "list": {
        String raw = n.attrs().get("v");
        if (raw != null) {
          List<Value> out = new ArrayList<>();
          for (String part : raw.split(",", -1)) {
            String p = part.trim();
            if (p.isEmpty()) {
              continue;
            }
            if (!p.matches("^-?[0-9]+$")) {
              throw new ComputeError("<list>: \"" + p + "\" is not an integer");
            }
            out.add(Value.of(new BigInteger(p)));
          }
          return Value.of(out);
        }
        List<Value> out = new ArrayList<>();
        for (TDCParser.ElementContext c : n.children()) {
          out.add(eval(c, scope));
        }
        return Value.of(out);
      }

      // references
      case "field": {
        String name = n.attrs().getOrDefault("name", "");
        String value = scope.fields().get(name);
        if (value == null) {
          throw new ComputeError("<field>: \"" + name + "\" is not in scope");
        }
        return Value.of(value);
      }
      case "var": {
        String name = n.attrs().getOrDefault("name", "");
        Value value = scope.vars().get(name);
        if (value == null) {
          throw new ComputeError("<var>: \"" + name + "\" is not bound");
        }
        return value;
      }
      case "current":
        if (scope.current() == null) {
          throw new ComputeError("<current/> used outside an iteration");
        }
        return scope.current();
      case "current_index":
        if (scope.currentIndex() == null) {
          throw new ComputeError("<current_index/> used outside an iteration");
        }
        return Value.of(scope.currentIndex());
      case "acc":
        if (scope.acc() == null) {
          throw new ComputeError("<acc/> used outside a <reduce>");
        }
        return scope.acc();
      case "let":
        throw new ComputeError("<let> is a binding prefix, not a value expression");

      // collections
      case "each": {
        List<Value> items = iterableOf(evalWrapper(n, "over", scope));
        Node body = requireChild(n, "do");
        List<Value> out = new ArrayList<>(items.size());
        for (int i = 0; i < items.size(); i++) {
          out.add(evalSlot(body.children(), scope.withIteration(items.get(i), BigInteger.valueOf(i), null)));
        }
        return Value.of(out);
      }
      case "reduce": {
        List<Value> items = iterableOf(evalWrapper(n, "over", scope));
        Node body = requireChild(n, "do");
        Value acc = evalWrapper(n, "init", scope);
        for (int i = 0; i < items.size(); i++) {
          acc = evalSlot(body.children(), scope.withIteration(items.get(i), BigInteger.valueOf(i), acc));
        }
        return acc;
      }
      case "join": {
        String sep = n.attrs().getOrDefault("sep", "");
        Value value = evalSlot(n.children(), scope);
        if (!(value instanceof Value.Lst l)) {
          throw new ComputeError("<join>: expected a list");
        }
        List<String> parts = new ArrayList<>(l.v().size());
        for (Value v : l.v()) {
          parts.add(Value.asStr(v));
        }
        return Value.of(String.join(sep, parts));
      }
      case "at": {
        Value coll = evalWrapper(n, "in", scope);
        if (!(coll instanceof Value.Lst l)) {
          throw new ComputeError("<at>: <in> must be a list");
        }
        int idx = Value.asInt(evalWrapper(n, "index", scope), "<at> index").intValueExact();
        if (idx >= 0 && idx < l.v().size()) {
          return l.v().get(idx);
        }
        String dflt = n.attrs().get("default");
        if (dflt != null) {
          return Value.of(Value.parseIntStrict(dflt));
        }
        throw new ComputeError("<at>: index " + idx + " is out of range and no default is set");
      }
      case "length": {
        Value value = evalSlot(n.children(), scope);
        if (value instanceof Value.Str s) {
          return Value.of(s.v().codePointCount(0, s.v().length()));
        }
        if (value instanceof Value.Lst l) {
          return Value.of(l.v().size());
        }
        throw new ComputeError("<length>: expected a string or list");
      }

      // arithmetic
      case "add": {
        BigInteger sum = BigInteger.ZERO;
        for (TDCParser.ElementContext c : n.children()) {
          sum = sum.add(Value.asInt(eval(c, scope), "<add>"));
        }
        return Value.of(sum);
      }
      case "multiply": {
        BigInteger product = BigInteger.ONE;
        for (TDCParser.ElementContext c : n.children()) {
          product = product.multiply(Value.asInt(eval(c, scope), "<multiply>"));
        }
        return Value.of(product);
      }
      case "subtract": {
        if (n.children().isEmpty()) {
          throw new ComputeError("<subtract> requires at least one child");
        }
        BigInteger acc = Value.asInt(eval(n.children().get(0), scope), "<subtract>");
        for (int i = 1; i < n.children().size(); i++) {
          acc = acc.subtract(Value.asInt(eval(n.children().get(i), scope), "<subtract>"));
        }
        return Value.of(acc);
      }
      case "mod": {
        List<TDCParser.ElementContext> two = requireTwo(n);
        return Value.of(
            Value.mod(Value.asInt(eval(two.get(0), scope)), Value.asInt(eval(two.get(1), scope))));
      }
      case "divide": {
        List<TDCParser.ElementContext> two = requireTwo(n);
        return Value.of(
            Value.floorDiv(
                Value.asInt(eval(two.get(0), scope)), Value.asInt(eval(two.get(1), scope))));
      }

      // conversion
      case "encode": {
        Value value = evalSlot(n.children(), scope);
        if (!(value instanceof Value.Str s)) {
          throw new ComputeError("<encode>: expected a single-character string");
        }
        return Value.of(Encode.encodeChar(s.v(), n.attrs().getOrDefault("as", "")));
      }
      case "to_number":
        return Value.of(Value.parseIntStrict(Value.asStr(evalSlot(n.children(), scope))));
      case "pad": {
        int width = intAttr(n, "width", 0);
        String fill = n.attrs().getOrDefault("fill", "0");
        return Value.of(padStart(Value.asStr(evalSlot(n.children(), scope)), width, fill));
      }
      case "concat": {
        StringBuilder out = new StringBuilder();
        for (TDCParser.ElementContext c : n.children()) {
          out.append(Value.asStr(eval(c, scope)));
        }
        return Value.of(out.toString());
      }

      // text
      case "upper":
      case "lower":
      case "capitalize":
      case "title":
        return Value.of(Transforms.applyCase(n.name(), Value.asStr(evalSlot(n.children(), scope))));
      case "mask":
        return Value.of(
            Mask.apply(n.attrs().getOrDefault("pattern", ""), Value.asStr(evalSlot(n.children(), scope))));
      case "slice": {
        String to = n.attrs().get("to");
        return Value.of(
            Transforms.slice(
                Value.asStr(evalSlot(n.children(), scope)),
                intAttr(n, "from", 0),
                to == null ? null : Integer.valueOf(to.trim())));
      }
      case "replace": {
        String from = n.attrs().getOrDefault("from", "");
        String value = Value.asStr(evalSlot(n.children(), scope));
        return Value.of(from.isEmpty() ? value : value.replace(from, n.attrs().getOrDefault("to", "")));
      }
      case "trim":
        return Value.of(Value.asStr(evalSlot(n.children(), scope)).trim());
      case "group":
        return Value.of(
            Transforms.group(
                Value.asStr(evalSlot(n.children(), scope)),
                intAttr(n, "size", 3),
                n.attrs().getOrDefault("sep", " ")));

      case "choose":
        return evalChoose(n, scope);

      // Role wrappers carry no meaning of their own; they name a slot.
      case "result":
      case "do":
      case "over":
      case "init":
      case "in":
      case "index":
      case "then":
      case "otherwise":
        return evalSlot(n.children(), scope);

      default:
        throw new ComputeError("unknown compute tag <" + n.name() + ">");
    }
  }

  private static Value evalChoose(Node n, Scope scope) {
    Node otherwise = null;
    for (TDCParser.ElementContext child : n.children()) {
      Node cn = node(child);
      if ("when".equals(cn.name())) {
        if (evalTest(requireChild(cn, "test"), scope)) {
          return evalSlot(requireChild(cn, "then").children(), scope);
        }
      } else if ("otherwise".equals(cn.name())) {
        otherwise = cn;
      }
    }
    if (otherwise != null) {
      return evalSlot(otherwise.children(), scope);
    }
    throw new ComputeError("<choose>: no <when> matched and no <otherwise> present");
  }

  private static boolean evalTest(Node test, Scope scope) {
    if (test.children().isEmpty()) {
      throw new ComputeError("<test> requires a predicate child");
    }
    return evalPredicate(test.children().get(0), scope);
  }

  private static boolean evalPredicate(TDCParser.ElementContext el, Scope scope) {
    Node n = node(el);
    switch (n.name()) {
      case "equals":
      case "greater_than":
      case "less_than": {
        List<TDCParser.ElementContext> two = requireTwo(n);
        BigInteger x = Value.asInt(eval(two.get(0), scope), "<" + n.name() + ">");
        BigInteger y = Value.asInt(eval(two.get(1), scope), "<" + n.name() + ">");
        return switch (n.name()) {
          case "equals" -> x.equals(y);
          case "greater_than" -> x.compareTo(y) > 0;
          default -> x.compareTo(y) < 0;
        };
      }
      case "is_digit": {
        if (n.children().isEmpty()) {
          throw new ComputeError("<is_digit> requires a child");
        }
        Value value = eval(n.children().get(0), scope);
        return value instanceof Value.Str s && s.v().matches("^[0-9]$");
      }
      default:
        throw new ComputeError("unknown predicate <" + n.name() + "> (valid only inside <test>)");
    }
  }

  // ── tree helpers ─────────────────────────────────────────────────────────────────────────

  /** A string iterates by code point, a list by element. Anything else cannot be walked. */
  private static List<Value> iterableOf(Value value) {
    if (value instanceof Value.Str s) {
      List<Value> out = new ArrayList<>();
      s.v().codePoints().forEach(cp -> out.add(Value.of(new String(Character.toChars(cp)))));
      return out;
    }
    if (value instanceof Value.Lst l) {
      return new ArrayList<>(l.v());
    }
    throw new ComputeError("<over>: expected a string or list to iterate");
  }

  private static Node node(TDCParser.ElementContext el) {
    TDCParser.OpenCloseElementContext open = el.openCloseElement();
    if (open != null) {
      return new Node(open.name.getText(), attributes(open.attr()), elements(open.content()));
    }
    TDCParser.SelfClosingElementContext self = el.selfClosingElement();
    if (self != null) {
      return new Node(self.name.getText(), attributes(self.attr()), List.of());
    }
    throw new ComputeError("unexpected <data> or malformed element inside <compute>");
  }

  private static String nodeName(TDCParser.ElementContext el) {
    TDCParser.OpenCloseElementContext open = el.openCloseElement();
    if (open != null) {
      return open.name.getText();
    }
    TDCParser.SelfClosingElementContext self = el.selfClosingElement();
    return self != null ? self.name.getText() : "";
  }

  private static Node requireChild(Node n, String name) {
    for (TDCParser.ElementContext child : n.children()) {
      if (name.equals(nodeName(child))) {
        return node(child);
      }
    }
    throw new ComputeError("<" + n.name() + "> requires a <" + name + "> child");
  }

  private static List<TDCParser.ElementContext> requireTwo(Node n) {
    if (n.children().size() != 2) {
      throw new ComputeError("<" + n.name() + "> requires exactly 2 children");
    }
    return n.children();
  }

  private static List<TDCParser.ElementContext> elements(TDCParser.ContentContext content) {
    return content == null ? List.of() : content.element();
  }

  private static Map<String, String> attributes(List<TDCParser.AttrContext> attrs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (TDCParser.AttrContext attr : attrs) {
      String raw = attr.attrValue.getText();
      out.put(attr.attrName.getText(), raw.substring(1, raw.length() - 1));
    }
    return out;
  }

  private static int intAttr(Node n, String name, int fallback) {
    String raw = n.attrs().get(name);
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    try {
      return Integer.parseInt(raw.trim());
    } catch (NumberFormatException e) {
      throw new ComputeError("<" + n.name() + ">: \"" + name + "\" must be a whole number");
    }
  }

  /** Pad on the left by code point, so a multi-character fill repeats and then truncates. */
  private static String padStart(String value, int width, String fill) {
    int length = value.codePointCount(0, value.length());
    if (length >= width || fill.isEmpty()) {
      return value;
    }
    StringBuilder pad = new StringBuilder();
    while (pad.codePointCount(0, pad.length()) < width - length) {
      pad.append(fill);
    }
    List<String> cps = Mask.codePoints(pad.toString());
    return String.join("", cps.subList(0, width - length)) + value;
  }

  /** Adapts a plain map for {@link Fields}. */
  public static Fields fieldsOf(Function<String, String> lookup) {
    return lookup::apply;
  }
}
