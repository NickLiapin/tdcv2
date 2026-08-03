package io.github.nickliapin.tdc.parser;

import io.github.nickliapin.tdc.generators.RegexGen;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.parser.generated.TDCParser;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.antlr.v4.runtime.ParserRuleContext;
import org.antlr.v4.runtime.tree.ParseTree;

/** Turns a parse tree into the {@link Config} the engine reads. */
public final class ConfigBuilder {

  private static final int DEFAULT_COUNT = 10;
  private static final String DEFAULT_LOCALE = "en";
  private static final String DEFAULT_INJECT = "${{%}}";

  private ConfigBuilder() {}

  public static Config build(TDCParser.DocumentContext document) {
    return build(document, null);
  }

  /**
   * The whole config, as the engines need it.
   *
   * <p>{@code defaultLocale} fills in for a config that declares no {@code <env local="…">} — it
   * comes from the project's {@code tdcv2.config.json}, and it is a DEFAULT, never an override.
   * Letting it beat what the config declares would make a config that says {@code local="ru"}
   * produce English wherever a config file existed, which {@code init} always writes.
   */
  public static Config build(TDCParser.DocumentContext document, String defaultLocale) {
    TDCParser.OpenCloseElementContext tdc = findElement(document, "tdc");
    if (tdc == null) {
      throw new IllegalArgumentException("document has no <tdc> root element");
    }

    TDCParser.OpenCloseElementContext env = findElement(tdc.content(), "env");
    Map<String, String> envAttrs = env == null ? Map.of() : attributes(env.attr());
    // regex_max_length sits on <tdc>, not <env>: it is a safety limit for the whole document
    // rather than a property of one run's data.
    int regexMaxLength = RegexGen.parseMaxLength(attributes(tdc.attr()).get("regex_max_length"));

    int count = DEFAULT_COUNT;
    String rawCount = envAttrs.get("count");
    if (rawCount != null) {
      count = Integer.parseInt(rawCount.trim());
    }

    List<Config.SequenceSpec> sequences = new ArrayList<>();
    List<Config.Line> before = List.of();
    List<Config.Line> after = List.of();
    List<Config.Line> beforeBlock = List.of();
    List<Config.Line> afterBlock = List.of();
    List<Config.Line> delimiterBlock = List.of();
    List<Config.Line> beforeLine = List.of();
    List<Config.Line> afterLine = List.of();
    List<Config.Line> delimiterLine = List.of();

    List<List<String>> envUniq = new ArrayList<>();
    List<List<String>> envDistinct = new ArrayList<>();
    List<Config.PoolSpec> pools = new ArrayList<>();

    if (env != null) {
      for (TDCParser.ElementContext child : env.content().element()) {
        TDCParser.OpenCloseElementContext open = child.openCloseElement();
        if (open == null) {
          continue;
        }
        switch (open.name.getText()) {
          case "sequence" -> sequences.add(sequence(open));
          case "pool" -> pools.add(pool(open));
          // <uniq> and <distinct> around whole sequences, rather than around the fields of one.
          // The wrapper says what must hold between them; its children are ordinary sequences.
          case "uniq" -> {
            List<String> group = wrappedSequences(open, sequences);
            if (group.size() >= 2) {
              envUniq.add(group);
            }
          }
          case "distinct" -> {
            List<String> group = wrappedSequences(open, sequences);
            if (group.size() >= 2) {
              envDistinct.add(group);
            }
          }
          case "mix" -> sequences.add(mixSequence(open));
          case "switch" -> sequences.add(switchSequence(open));
          case "before" -> before = lines(open.content());
          case "after" -> after = lines(open.content());
          case "before_block" -> beforeBlock = lines(open.content());
          case "after_block" -> afterBlock = lines(open.content());
          case "delimiter_block" -> delimiterBlock = lines(open.content());
          case "before_line" -> beforeLine = lines(open.content());
          case "after_line" -> afterLine = lines(open.content());
          case "delimiter_line" -> delimiterLine = lines(open.content());
          default -> {
            // Anything else in <env> is not modelled yet. Silence here is a known gap, not
            // a decision that it is unimportant — the fixtures that use it will surface it.
          }
        }
      }
    }

    TDCParser.OpenCloseElementContext block = findElement(tdc.content(), "block");
    if (block == null) {
      throw new IllegalArgumentException("<tdc> has no <block> child — nothing to render");
    }

    return new Config(
        count,
        envAttrs.getOrDefault("seed", ""),
        envAttrs.getOrDefault(
            "local", defaultLocale == null || defaultLocale.isBlank()
                ? DEFAULT_LOCALE
                : defaultLocale),
        envAttrs.getOrDefault("inject", DEFAULT_INJECT),
        regexMaxLength,
        sequences,
        lines(block.content()),
        new Config.Fixtures(
            before,
            after,
            beforeBlock,
            afterBlock,
            delimiterBlock,
            beforeLine,
            afterLine,
            delimiterLine),
        envAttrs.get("mode"),
        envAttrs.get("engine"),
        envUniq,
        envDistinct,
        pools);
  }

  /**
   * A {@code <pool>}, read with the very same walk its enclosing {@code <env>} gets.
   *
   * <p>That is the whole design in one method: nothing here knows what a member is, because a
   * member of a pool is a member of an {@code <env>}. Lenient about a missing name or an
   * unreadable count — the validator is what says so, and declaring the failure twice lets the
   * two drift apart.
   */
  private static Config.PoolSpec pool(TDCParser.OpenCloseElementContext node) {
    Map<String, String> attrs = attributes(node.attr());
    int count;
    try {
      count = Integer.parseInt(attrs.getOrDefault("count", "").trim());
    } catch (NumberFormatException ignored) {
      count = 0;
    }

    List<Config.SequenceSpec> sequences = new ArrayList<>();
    List<List<String>> uniq = new ArrayList<>();
    List<List<String>> distinct = new ArrayList<>();
    for (TDCParser.ElementContext child : node.content().element()) {
      TDCParser.OpenCloseElementContext inner = child.openCloseElement();
      if (inner == null) {
        continue;
      }
      switch (inner.name.getText()) {
        case "sequence" -> sequences.add(sequence(inner));
        case "mix" -> sequences.add(mixSequence(inner));
        case "switch" -> sequences.add(switchSequence(inner));
        case "uniq" -> {
          List<String> group = wrappedSequences(inner, sequences);
          if (group.size() >= 2) {
            uniq.add(group);
          }
        }
        case "distinct" -> {
          List<String> group = wrappedSequences(inner, sequences);
          if (group.size() >= 2) {
            distinct.add(group);
          }
        }
        default -> {
          // The validator reports anything a pool may not hold.
        }
      }
    }

    return new Config.PoolSpec(
        attrs.getOrDefault("name", ""), count, sequences, uniq, distinct);
  }

  /**
   * The sequences inside an env-level {@code <uniq>} or {@code <distinct>}, declared as they go.
   *
   * <p>Wrapping changes what must hold between them, not what they are, so each is built exactly
   * as it would have been on its own and the wrapper keeps only the names.
   */
  private static List<String> wrappedSequences(
      TDCParser.OpenCloseElementContext wrapper, List<Config.SequenceSpec> sequences) {
    List<String> names = new ArrayList<>();
    for (TDCParser.ElementContext inner : wrapper.content().element()) {
      TDCParser.OpenCloseElementContext open = inner.openCloseElement();
      if (open == null) {
        continue;
      }
      // A <mix> is a member like any other: a group rearranges whole columns between rows, and a
      // mix keeps its value multiset whatever the order, so its percentages survive the move. A
      // <switch> does not — its value answers the subject of ITS row — so it is not collected.
      Config.SequenceSpec spec;
      if ("sequence".equals(open.name.getText())) {
        spec = sequence(open);
      } else if ("mix".equals(open.name.getText())) {
        spec = mixSequence(open);
      } else if ("switch".equals(open.name.getText())) {
        spec = switchSequence(open);
      } else {
        continue;
      }
      sequences.add(spec);
      if (spec.name() != null && !spec.name().isEmpty()) {
        names.add(spec.name());
      }
    }
    return names;
  }

  /**
   * Parse a lone {@code <gen .../>} tag, as found in the body of a generator pack.
   *
   * <p>Through the same grammar the rest of the config goes through, rather than a quick regular
   * expression over the attributes. A pack body is config, written by the same people in the
   * same language, and it should fail the same way when it is wrong.
   */
  public static Config.Gen parseGenTag(String source) {
    TdcParserFacade.Result parsed = TdcParserFacade.parse(source);
    if (!parsed.ok()) {
      throw new IllegalArgumentException("pack generator did not parse: " + parsed.problems());
    }
    for (TDCParser.ElementContext element : parsed.tree().element()) {
      TDCParser.SelfClosingElementContext self = element.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        Map<String, String> attrs = attributes(self.attr());
        String type = attrs.getOrDefault("type", "");
        if (type.isEmpty()) {
          throw new IllegalArgumentException(
              "<gen> in a generator body is missing a \"type\" attribute");
        }
        if (!List.of(PRIMITIVE_GENERATOR_TYPES).contains(type)) {
          throw new IllegalArgumentException(
              "generator type \""
                  + type
                  + "\" is not supported as a single-<gen> body (supported: "
                  + String.join(", ", PRIMITIVE_GENERATOR_TYPES)
                  + "); to reference data, use <sequence>\u2026</sequence> + <data>");
        }
        return new Config.Gen(type, attrs);
      }
    }
    throw new IllegalArgumentException("pack generator body has no <gen> tag: " + source);
  }

  /**
   * A composed pack generator: local sequences, an output template, and an optional
   * {@code <valid>} predicate.
   *
   * <p>The body is wrapped in a document before parsing, exactly as the reference does, so a
   * pack is written in the same language as a config and parsed by the same grammar.
   */
  public record PackGenerator(
      List<Config.SequenceSpec> sequences,
      String output,
      TDCParser.OpenCloseElementContext validate) {}

  public static PackGenerator parsePackBody(String body) {
    TdcParserFacade.Result parsed = TdcParserFacade.parse("<tdc><env count=\"1\">" + body + "</env></tdc>");
    if (!parsed.ok()) {
      throw new IllegalArgumentException("pack generator did not parse: " + parsed.problems());
    }
    TDCParser.OpenCloseElementContext tdc = findElement(parsed.tree(), "tdc");
    TDCParser.OpenCloseElementContext env = tdc == null ? null : findElement(tdc.content(), "env");
    if (env == null) {
      throw new IllegalArgumentException("pack generator body did not parse");
    }

    List<Config.SequenceSpec> sequences = new ArrayList<>();
    String output = null;
    for (TDCParser.ElementContext child : env.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && "sequence".equals(open.name.getText())) {
        String refused = wholeColumnDeclaration(open);
        if (refused != null) {
          throw new IllegalArgumentException(refused);
        }
        String badType = disallowedGenType(open);
        if (badType != null) {
          throw new IllegalArgumentException(badType);
        }
        sequences.add(sequence(open));
        continue;
      }
      TDCParser.DataElementContext data = child.dataElement();
      if (data instanceof TDCParser.DataWithBodyContext withBody) {
        output = PairedData.restore(withBody.dataContent().getText());
      }
    }
    if (output == null) {
      throw new IllegalArgumentException(
          "a composed pack generator needs a <data>...</data> output template");
    }
    return new PackGenerator(sequences, output, findElement(env.content(), "valid"));
  }

  /**
   * Generator types a pack may use as its whole body.
   *
   * <p>A pack is a value, so its body may only be something that PRODUCES one on its own. What is
   * missing from this list is what makes it worth having: {@code file} would read a path relative
   * to nothing in particular, {@code http} would put a network call behind an address that looks
   * like a word list, and {@code template} would let one pack call another and cycle.
   */
  private static final String[] PRIMITIVE_GENERATOR_TYPES = {
    "text", "number", "regex", "advanced_regex", "symbol", "date", "increment", "decrement"
  };

  /**
   * Types allowed for a {@code <gen>} inside a composed pack's local sequences. {@code template} is
   * allowed here and not above: a composed body's whole purpose is to join values that come from
   * data lists, and a data list is a leaf, so no cycle is possible through one.
   */
  private static final List<String> COMPOSED_GEN_TYPES =
      List.of(
          "text",
          "number",
          "regex",
          "advanced_regex",
          "symbol",
          "date",
          "increment",
          "decrement",
          "template");

  /**
   * The first {@code <gen>} in this subtree whose type a pack may not use, said as a refusal, or
   * null when every one of them is allowed.
   *
   * <p>The parse tree is walked rather than the built spec: a {@code <mix>} nested inside a pack's
   * {@code <sequence>} does not reach the spec here, so walking the spec would look straight past
   * the one place a network call is easiest to hide.
   */
  private static String disallowedGenType(TDCParser.OpenCloseElementContext element) {
    for (ParserRuleContext node : descendants(element)) {
      String name;
      Map<String, String> attrs;
      if (node instanceof TDCParser.SelfClosingElementContext self) {
        name = self.name.getText();
        attrs = attributes(self.attr());
      } else if (node instanceof TDCParser.OpenCloseElementContext open) {
        name = open.name.getText();
        attrs = attributes(open.attr());
      } else {
        continue;
      }
      if (!"gen".equals(name)) {
        continue;
      }
      String type = attrs.getOrDefault("type", "");
      if (!type.isEmpty() && !COMPOSED_GEN_TYPES.contains(type)) {
        return "generator uses <gen type=\"" + type + "\"> which is not allowed inside a pack generator";
      }
    }
    return null;
  }

  /** Every element below this one, self-closing and paired alike, depth first. */
  private static List<ParserRuleContext> descendants(TDCParser.OpenCloseElementContext element) {
    List<ParserRuleContext> found = new ArrayList<>();
    if (element.content() == null) {
      return found;
    }
    for (TDCParser.ElementContext child : element.content().element()) {
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null) {
        found.add(self);
        continue;
      }
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null) {
        found.add(open);
        found.addAll(descendants(open));
      }
    }
    return found;
  }

  /**
   * Whole-COLUMN declarations, which a pack body cannot honour.
   *
   * <p>A pack describes how to build ONE value and is asked for one per row. These two say
   * something about the column as a whole — which values may repeat across rows, and in what order
   * they come out — and answering that needs the row count and every other row, neither of which a
   * pack has. Worse, one pack can be drawn from by several sequences in one config, so there is no
   * single column for the pack to be speaking about.
   *
   * <p>{@code <distinct>} is deliberately NOT here. It reads like a sibling of {@code uniq=} and is
   * not one: it constrains fields against each other WITHIN one row, which is exactly what a pack
   * can answer on its own — and five shipped full-name packs rely on it to keep a person's two
   * surnames from coming out the same.
   */
  private static final String[] WHOLE_COLUMN_ATTRS = {"uniq", "order"};

  /** Why this pack sequence is refused, or null when there is nothing wrong with it. */
  private static String wholeColumnDeclaration(TDCParser.OpenCloseElementContext sequence) {
    Map<String, String> attrs = attributes(sequence.attr());
    String named = attrs.get("name");
    String where = named == null ? "<sequence>" : "<sequence name=\"" + named + "\">";
    for (String attr : WHOLE_COLUMN_ATTRS) {
      String value = attrs.get(attr);
      if (value == null || value.isBlank()) {
        continue;
      }
      return "generator declares "
          + attr
          + "= on "
          + where
          + ", which a pack cannot honour: a pack builds ONE value and is asked for one per row,"
          + " while "
          + attr
          + "= is a property of the whole column. Declare it on the sequence in the config that"
          + " draws from this pack instead.";
    }
    return null;
  }

  /** One {@code <gen>} as a body item: a field when named, a drawn part otherwise. */
  private static Config.Item itemOf(Map<String, String> attrs) {
    Config.Gen gen = new Config.Gen(attrs.getOrDefault("type", ""), attrs);
    String fieldName = attrs.get("name");
    if (fieldName != null && !fieldName.isEmpty()) {
      return Config.Item.ofField(new Config.Field(fieldName, gen));
    }
    return Config.Item.ofGen(gen);
  }

  /** A standalone {@code <mix name="…">} in {@code <env>} is a sequence in its own right. */
  private static Config.SequenceSpec mixSequence(TDCParser.OpenCloseElementContext element) {
    Map<String, String> attrs = attributes(element.attr());
    return new Config.SequenceSpec(
        attrs.get("name"), attrs.get("parent"), null, null, null, null, null, mix(element), null, null,
        false);
  }

  private static Config.Mix mix(TDCParser.OpenCloseElementContext element) {
    Map<String, String> attrs = attributes(element.attr());
    List<Config.Case> cases = new ArrayList<>();
    for (TDCParser.ElementContext child : element.content().element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && "case".equals(open.name.getText())) {
        cases.add(caseSpec(open));
      }
    }
    return new Config.Mix(attrs.get("percent"), attrs.get("flag"), cases);
  }

  /** A case body: literal text, generators and nested mixes, concatenated in order. */
  private static Config.Case caseSpec(TDCParser.OpenCloseElementContext element) {
    List<Config.CasePart> parts = new ArrayList<>();
    for (TDCParser.ElementContext child : element.content().element()) {
      TDCParser.DataElementContext data = child.dataElement();
      if (data instanceof TDCParser.DataWithBodyContext body) {
        parts.add(
            new Config.CasePart(
                PairedData.restore(body.dataContent().getText()), null, null));
        continue;
      }
      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        Map<String, String> genAttrs = attributes(self.attr());
        parts.add(
            new Config.CasePart(
                null, new Config.Gen(genAttrs.getOrDefault("type", ""), genAttrs), null));
        continue;
      }
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && "mix".equals(open.name.getText())) {
        parts.add(new Config.CasePart(null, null, mix(open)));
      }
    }
    return new Config.Case(parts, "true".equals(attributes(element.attr()).get("anomaly")));
  }

  private static Config.SequenceSpec switchSequence(TDCParser.OpenCloseElementContext element) {
    Map<String, String> attrs = attributes(element.attr());
    List<Config.SwitchEntry> entries = new ArrayList<>();
    Config.Case fallback = null;

    for (TDCParser.ElementContext child : element.content().element()) {
      TDCParser.MapElementContext mapEl = child.mapElement();
      if (mapEl != null) {
        entries.addAll(mapEntries(mapText(mapEl)));
        continue;
      }
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null) {
        continue;
      }
      switch (open.name.getText()) {
        case "case" -> {
          List<String> keys = splitKeys(attributes(open.attr()).getOrDefault("is", ""));
          if (!keys.isEmpty()) {
            entries.add(new Config.SwitchEntry(keys, caseSpec(open)));
          }
        }
        case "default" -> fallback = caseSpec(open);
        default -> {
          // Nothing else is meaningful inside a <switch>; the validator names it.
        }
      }
    }
    return new Config.SequenceSpec(
        attrs.get("name"),
        attrs.get("parent"),
        null,
        null,
        null,
        null,
        null,
        null,
        new Config.Switch(attrs.getOrDefault("on", ""), entries, fallback),
        null,
        false);
  }

  /** The raw body of a {@code <map>}; a self-closing one carries none. */
  private static String mapText(TDCParser.MapElementContext element) {
    if (element instanceof TDCParser.MapWithBodyContext body) {
      return body.mapContent().getText();
    }
    return "";
  }

  /**
   * A compact {@code <map>} table: comma-separated rows of {@code KEYS:VALUE}.
   *
   * <p>Split on the <em>first</em> colon only, so a value may contain colons — a time of day or
   * a namespaced identifier survives on the right-hand side.
   */
  private static List<Config.SwitchEntry> mapEntries(String text) {
    List<Config.SwitchEntry> out = new ArrayList<>();
    for (String rawRow : text.split(",", -1)) {
      String row = rawRow.trim();
      if (row.isEmpty()) {
        continue;
      }
      int colon = row.indexOf(':');
      if (colon < 0) {
        continue;
      }
      List<String> keys = splitKeys(row.substring(0, colon));
      if (keys.isEmpty()) {
        continue;
      }
      String value = row.substring(colon + 1).trim();
      out.add(
          new Config.SwitchEntry(
              keys, new Config.Case(List.of(new Config.CasePart(value, null, null)), false)));
    }
    return out;
  }

  /** {@code US|CA|MX} — any one of them selects the entry. */
  private static List<String> splitKeys(String raw) {
    List<String> out = new ArrayList<>();
    for (String key : raw.split("\\|", -1)) {
      String trimmed = key.trim();
      if (!trimmed.isEmpty()) {
        out.add(trimmed);
      }
    }
    return out;
  }

  private static Config.SequenceSpec sequence(TDCParser.OpenCloseElementContext element) {
    Map<String, String> attrs = attributes(element.attr());
    String name = attrs.get("name");
    String parent = attrs.get("parent");

    List<Map<String, String>> gens = new ArrayList<>();
    List<List<String>> distinctGroups = new ArrayList<>();
    // The body in source order, kept beside `gens` so the ordinary shapes are read exactly as they
    // were and only a body that composes takes the new path.
    List<Config.Item> items = new ArrayList<>();
    boolean sawData = false;
    int unnamedGens = 0;

    for (TDCParser.ElementContext child : element.content().element()) {
      if (child.dataElement() instanceof TDCParser.DataWithBodyContext data) {
        sawData = true;
        String text = PairedData.restore(data.dataContent().getText());
        String constant = attributes(data.attr()).get("name");
        if (constant != null && !constant.isEmpty()) {
          items.add(Config.Item.ofConstant(constant, text));
        } else if (!text.isEmpty()) {
          items.add(Config.Item.ofText(text));
        }
        continue;
      }

      TDCParser.SelfClosingElementContext self = child.selfClosingElement();
      if (self != null && "gen".equals(self.name.getText())) {
        Map<String, String> genAttrs = attributes(self.attr());
        Config.Item item = itemOf(genAttrs);
        if (item.gen() != null) {
          unnamedGens++;
        }
        items.add(item);
        gens.add(genAttrs);
        continue;
      }
      // A <distinct> wrapper holds gens that must differ from each other within one row. Its
      // children are ordinary fields of the compound; the wrapper only records the constraint.
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open != null && "distinct".equals(open.name.getText())) {
        List<String> group = new ArrayList<>();
        for (TDCParser.ElementContext inner : open.content().element()) {
          TDCParser.SelfClosingElementContext innerGen = inner.selfClosingElement();
          if (innerGen != null && "gen".equals(innerGen.name.getText())) {
            Map<String, String> genAttrs = attributes(innerGen.attr());
            Config.Item item = itemOf(genAttrs);
            if (item.gen() != null) {
              unnamedGens++;
            }
            items.add(item);
            gens.add(genAttrs);
            String fieldName = genAttrs.get("name");
            if (fieldName != null && !fieldName.isEmpty()) {
              group.add(fieldName);
            }
          }
        }
        // A group of one carries no constraint — there is nothing for it to differ from.
        if (group.size() >= 2) {
          distinctGroups.add(group);
        }
      }
    }

    // A <compute> sequence derives its value instead of drawing one, so it has no <gen> at all.
    // This is how a check digit lives as editable pack data rather than as engine code.
    TDCParser.OpenCloseElementContext compute = findElement(element.content(), "compute");
    if (compute != null) {
      return new Config.SequenceSpec(name, parent, null, null, null, compute);
    }

    if (gens.isEmpty()) {
      throw new IllegalArgumentException("sequence \"" + name + "\" has no <gen> child");
    }

    // Conditional is checked first, so a branch written as `<gen if="...">` is not asked for a
    // name it has no use for.
    boolean conditional = gens.stream().anyMatch(g -> g.containsKey("if"));
    if (conditional) {
      List<Config.Branch> branches = new ArrayList<>();
      for (Map<String, String> g : gens) {
        Map<String, String> genAttrs = new LinkedHashMap<>(g);
        // `if` is the branch's condition, not a setting the generator should see.
        String condition = genAttrs.remove("if");
        branches.add(
            new Config.Branch(
                condition, new Config.Gen(genAttrs.getOrDefault("type", ""), genAttrs)));
      }
      return new Config.SequenceSpec(name, parent, null, null, branches);
    }

    // Composed when the body is not simply one unnamed gen or a set of named ones: the unnamed
    // gens and the literals build the sequence's own value and the named ones stay fields beside
    // it. Checked before compound, because a body with both readings is the composed one — that is
    // where ${{Name}} gets a value.
    if (sawData || (unnamedGens > 0 && gens.size() > 1)) {
      return Config.SequenceSpec.composed(
          name,
          parent,
          items,
          distinctGroups.isEmpty() ? null : distinctGroups,
          "true".equals(attrs.get("uniq")));
    }

    // Compound when there is more than one gen, or when the only one is named — the second
    // case lets a one-field compound be written deliberately.
    boolean compound = gens.size() > 1 || gens.get(0).containsKey("name");
    if (compound) {
      List<Config.Field> fields = new ArrayList<>();
      for (Map<String, String> g : gens) {
        String fieldName = g.get("name");
        if (fieldName == null || fieldName.isEmpty()) {
          continue;
        }
        fields.add(
            new Config.Field(fieldName, new Config.Gen(g.getOrDefault("type", ""), g)));
      }
      return new Config.SequenceSpec(
          name,
          parent,
          null,
          fields,
          null,
          null,
          null,
          null,
          null,
          distinctGroups.isEmpty() ? null : distinctGroups,
          "true".equals(attrs.get("uniq")));
    }

    // `uniq` travels to the simple shape too — a draw without replacement
    // (engine/UniqSimple.java); dropping it silently was the bug that made
    // 100 "unique" names repeat.
    Map<String, String> genAttrs = gens.get(0);
    return new Config.SequenceSpec(
        name,
        parent,
        new Config.Gen(genAttrs.getOrDefault("type", ""), genAttrs),
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "true".equals(attrs.get("uniq")));
  }

  /** Every {@code <line>} under a container, each flattened to its {@code <data>} text. */
  private static List<Config.Line> lines(TDCParser.ContentContext content) {
    List<Config.Line> out = new ArrayList<>();
    if (content == null) {
      return out;
    }
    for (TDCParser.ElementContext child : content.element()) {
      TDCParser.OpenCloseElementContext open = child.openCloseElement();
      if (open == null || !"line".equals(open.name.getText())) {
        continue;
      }
      List<Config.DataPart> parts = new ArrayList<>();
      for (TDCParser.ElementContext inner : open.content().element()) {
        TDCParser.DataElementContext data = inner.dataElement();
        if (data instanceof TDCParser.DataWithBodyContext body) {
          Map<String, String> dataAttrs = attributes(body.attr());
          parts.add(
              new Config.DataPart(
                  PairedData.restore(body.dataContent().getText()),
                  dataAttrs.get("if"),
                  dataAttrs.get("name"),
                  dataAttrs.get("type")));
        }
      }
      Map<String, String> lineAttrs = attributes(open.attr());
      out.add(new Config.Line(parts, lineAttrs.get("if"), lineAttrs.get("each")));
    }
    return out;
  }

  private static Map<String, String> attributes(List<TDCParser.AttrContext> attrs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (TDCParser.AttrContext attr : attrs) {
      String raw = attr.attrValue.getText();
      // The lexer hands back the quotes as part of the token.
      out.put(attr.attrName.getText(), raw.substring(1, raw.length() - 1));
    }
    return out;
  }

  private static TDCParser.OpenCloseElementContext findElement(ParseTree parent, String name) {
    for (int i = 0; i < parent.getChildCount(); i++) {
      ParseTree child = parent.getChild(i);
      TDCParser.OpenCloseElementContext open = null;
      if (child instanceof TDCParser.ElementContext element) {
        open = element.openCloseElement();
      } else if (child instanceof TDCParser.OpenCloseElementContext direct) {
        open = direct;
      }
      if (open != null && name.equals(open.name.getText())) {
        return open;
      }
    }
    return null;
  }

  private static TDCParser.SelfClosingElementContext findSelfClosing(
      TDCParser.ContentContext content, String name) {
    if (content == null) {
      return null;
    }
    for (TDCParser.ElementContext element : content.element()) {
      TDCParser.SelfClosingElementContext self = element.selfClosingElement();
      if (self != null && name.equals(self.name.getText())) {
        return self;
      }
    }
    return null;
  }
}
