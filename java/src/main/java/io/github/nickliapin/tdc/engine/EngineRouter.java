package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Predicate;

/**
 * Which engine runs a config.
 *
 * <p>A config does not name an engine — it states a constraint, and the router picks the fastest
 * engine that can honour it. {@code mode="memory"} means the whole run may be held at once;
 * {@code mode="disk"} means it may not, and the choice between the two streaming engines follows
 * from what the config actually asks for. Naming an engine outright with {@code engine="1|2|3"}
 * is available and skips all of this, which is what makes it useful for a benchmark and a poor
 * default for everything else.
 *
 * <p>The interesting decisions are the ones that route a disk-mode config back to memory. Each
 * marks something whose answer depends on the whole column — an interpolated pack address, an
 * exact share declared inside a pack, a weighted draw of a linked row. Answered a row at a time
 * they do not fail; they quietly produce data that is wrong in a way nobody notices, which is
 * the worst outcome available and the reason these checks exist.
 */
public final class EngineRouter {

  private EngineRouter() {}

  /**
   * The engine a run uses, and why — what {@code check} prints. {@code downgraded} is true when
   * engine 3 was asked for and engine 1 runs the config instead.
   */
  public record Choice(int engine, String why, boolean downgraded) {

    Choice(int engine, String why) {
      this(engine, why, false);
    }

    /** One line for {@code check}: the engine, its name, and the reason. */
    public String describe() {
      String named = "engine " + engine + " (" + label(engine) + ")";
      return downgraded ? "runs on " + named + ", not engine 3: " + why : "runs on " + named + ": " + why;
    }
  }

  /** How each engine is named next to its number. */
  public static String label(int engine) {
    return switch (engine) {
      case 1 -> "in memory";
      case 2 -> "streaming";
      default -> "exact, on disk";
    };
  }

  /** The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk. */
  public static int resolve(Config config, DataPacks packs) {
    return explain(config, packs).engine();
  }

  /**
   * The engine a config runs on, and the reason in words.
   *
   * <p>Engine 3 asked for by name runs a config the disk route sends to engine 1 on engine 1, and
   * says so. It always did that, silently, at the last moment — the lazy build refused and the
   * in-memory engine took over — which left nothing for {@code check} to report and, past the row
   * count where a run splits itself into threads, handed each worker a refusal it could not take
   * over from: this implementation exited 1 there. Deciding it here, before the run, is the same
   * answer every implementation gives.
   */
  public static Choice explain(Config config, DataPacks packs) {
    String forced = trimToNull(config.engine());
    // engine= wins over mode= — except when the two contradict each other.
    //
    // mode="sequential" is not a preference about speed, it is a promise that row N is computed
    // after row N-1, which only engine 1 keeps. Letting engine="2" quietly override it produced
    // the worst possible message: the run failing with "add mode=sequential" against a config
    // that already said it. Naming both attributes is the whole fix.
    if ("sequential".equals(trimToNull(config.mode())) && forced != null && !"1".equals(forced)) {
      throw new IllegalArgumentException(
          "engine=\""
              + forced
              + "\" contradicts mode=\"sequential\": rows must be computed in order, and only "
              + "engine 1 does that. Drop one of the two.");
    }
    if (forced != null) {
      if (!"1".equals(forced) && !"2".equals(forced) && !"3".equals(forced)) {
        throw new IllegalArgumentException(
            "invalid engine \""
                + forced
                + "\" — expected \"1\" (in-memory), \"2\" (streaming), or \"3\" (exact-on-disk)");
      }
      if ("3".equals(forced)) {
        Choice disk = diskRoute(config);
        if (disk.engine() == 1) {
          return new Choice(1, disk.why(), true);
        }
      }
      return new Choice(Integer.parseInt(forced), "engine=\"" + forced + "\" on <env>");
    }
    String mode = trimToNull(config.mode());
    if ("memory".equals(mode)) {
      return new Choice(1, "mode=\"memory\" on <env>");
    }
    // "stream" is the old name for asking for Engine 2 outright, from before mode described the
    // constraint rather than the engine. Kept working; the router is not consulted.
    if ("stream".equals(mode)) {
      return new Choice(2, "mode=\"stream\" on <env>");
    }
    // "sequential" computes rows strictly in order, which is what prev() needs and what the
    // streaming engines cannot promise: engine 2 resolves ANY row in O(1) without touching the
    // one before it, and that is its whole design. So the mode forces engine 1, which
    // materialises in order. The cost is engine 1's — the run is held in memory — and it is
    // paid only by a config that asked for it.
    if ("sequential".equals(mode)) {
      return new Choice(1, "mode=\"sequential\" on <env>");
    }
    if (mode != null && !"disk".equals(mode)) {
      throw new IllegalArgumentException(
          "invalid mode \"" + mode + "\" — expected \"memory\", \"disk\" or \"sequential\"");
    }
    return diskRoute(config);
  }

  /** {@code mode="disk"}, the default: the fastest engine the config allows, and why. */
  private static Choice diskRoute(Config config) {
    // No mode at all means disk: a config says how big its run is, not how to hold it, and the
    // engine that can stream is the right default for a generator whose whole point is volume.

    // A template address that names a field resolves per row against the other columns; only
    // the in-memory engine has them all.
    String dynamic =
        genOwner(config, gen -> "template".equals(gen.type()) && isDynamic(gen.attr("value", "")));
    if (dynamic != null) {
      return new Choice(1, "\"" + dynamic + "\" picks its pack per row");
    }
    // weight= with row= draws a linked record to an exact quota, which needs the global total.
    String weightedRow =
        genOwner(
            config,
            gen ->
                "file".equals(gen.type())
                    && trimToNull(gen.attrs().get("weight")) != null
                    && trimToNull(gen.attrs().get("row")) != null);
    if (weightedRow != null) {
      return new Choice(
          1, "\"" + weightedRow + "\" draws a weighted row of a file (weight= with row=)");
    }
    // A pack generator that declares its own shares used to be routed here, and for a real
    // reason: resolved a row at a time the quota was computed over a single row and every row went
    // to the largest share. The streaming builder plans such a body over the COLUMN now, so the
    // reason is gone — and keeping the rule after the refusal went was worse than nothing, because
    // the config still landed on the engine that holds the whole table. Measured on a 5,000,000-row
    // `hu.person.male.fullName` column: the in-memory engine wanted 2 GB and died under a 512 MB
    // cap, while the streaming path finished the same run inside 512 MB.
    //
    // One shape still belongs here — a body carrying its own `<valid>` — and it arrives the way
    // every other unstreamable config does: the streaming builder refuses it by name.
    // A network call is not reproducible, so it never runs on the reproducible path.
    // uniq on a simple sequence draws WITHOUT REPLACEMENT — the pool and the
    // taken-set span the whole column, which only the in-memory engine holds.
    for (Config.SequenceSpec s : config.sequences()) {
      boolean drawn =
          s.gen() != null
              ? !counting(s.gen().type())
              : s.items() != null
                  && s.items().stream()
                      .anyMatch(
                          i -> i.gen() != null && i.field() == null && !counting(i.gen().type()));
      if (s.uniq() && drawn) {
        return new Choice(1, "uniq=\"true\" on \"" + s.name() + "\"");
      }
    }
    String http = genOwner(config, gen -> "http".equals(gen.type()));
    if (http != null) {
      return new Choice(1, "\"" + http + "\" calls a web service");
    }
    // A <switch> branch that declares a share the streaming engines cannot lay over the right
    // rows. They refuse such a branch rather than apportion it over the wrong denominator, and a
    // refusal reached at build time is not a fallback for every caller. Decide it here,
    // statically, where every path sees the same answer.
    String switchShare = unstreamableSwitchPercent(config);
    if (switchShare != null) {
      return new Choice(1, "a share inside \"" + switchShare + "\" needs the whole column");
    }
    // A column derived from other rows — a running total, a statistic, a date offset — is
    // refused by name by the streaming builder. Deciding it here keeps that refusal from reaching
    // a parallel worker, which has nothing to fall back to.
    String running = genOwner(config, gen -> "running".equals(gen.type()));
    if (running != null) {
      return new Choice(1, "\"" + running + "\" adds up the rows before it");
    }
    String stat = genOwner(config, gen -> "stat".equals(gen.type()));
    if (stat != null) {
      return new Choice(1, "\"" + stat + "\" is computed over every row");
    }
    String offset =
        genOwner(
            config,
            gen -> "date".equals(gen.type()) && trimToNull(gen.attrs().get("of")) != null);
    if (offset != null) {
      return new Choice(1, "\"" + offset + "\" is a date offset from another column");
    }
    // parent="Name" with no value narrows a column to the rows where the parent produced
    // anything, which needs the parent's whole column. Same reason as the three above.
    for (Config.SequenceSpec spec : config.sequences()) {
      String parent = trimmed(spec.parent());
      if (parent.isEmpty()) {
        continue;
      }
      int dot = parent.indexOf('.');
      if (dot < 0 || parent.substring(dot + 1).isEmpty()) {
        return new Choice(
            1, "\"" + spec.name() + "\" has parent=\"" + parent + "\" with no value");
      }
    }
    String exact = exactReason(config);
    return exact != null
        ? new Choice(3, exact)
        : new Choice(2, "every column can be built one row at a time");
  }

  /** Does this {@code <case>} body declare a share that the denominator has to be right for? */
  private static boolean caseCarriesPercent(Config.Case body) {
    if (body == null) {
      return false;
    }
    for (Config.CasePart part : body.parts()) {
      if (part.mix() != null && !trimmed(part.mix().percent()).isEmpty()) {
        return true;
      }
      if (part.gen() != null && !trimmed(part.gen().attrs().get("percent")).isEmpty()) {
        return true;
      }
    }
    return false;
  }

  private static String trimmed(String value) {
    return value == null ? "" : value.trim();
  }

  /**
   * A {@code <switch>} branch whose share the streaming engines cannot honour.
   *
   * <p>They can subset a branch keyed on ONE value of a plain values list — the same bijection
   * {@code parent="Gender.Male"} uses. They cannot rank a multi-key branch ({@code US|CA|MX} is a
   * union, and ranks across a union do not compose from the per-value ranks), nor
   * {@code <default>} (a complement, which nothing enumerates), nor any branch whose subject is
   * not a finite values list.
   *
   * <p>Deliberately conservative: anything it cannot prove streamable goes to engine 1, which
   * costs speed on an exotic config and never costs correctness.
   */
  /** Every {@code <switch>} written inside this {@code <case>} body, at any depth. */
  private static void nestedSwitches(Config.Case body, List<Config.Switch> found) {
    if (body == null) {
      return;
    }
    for (Config.CasePart part : body.parts()) {
      if (part.switchSpec() != null) {
        found.add(part.switchSpec());
        for (Config.SwitchEntry entry : part.switchSpec().entries()) {
          nestedSwitches(entry.value(), found);
        }
        nestedSwitches(part.switchSpec().fallback(), found);
      } else if (part.mix() != null) {
        for (Config.Case inner : part.mix().cases()) {
          nestedSwitches(inner, found);
        }
      }
    }
  }

  private static String unstreamableSwitchPercent(Config config) {
    for (Config.SequenceSpec spec : config.sequences()) {
      // A NESTED switch is never rankable — its branch covers an intersection of two partitions,
      // and there is no O(1) rank inside one. So any share it declares, at any depth, decides
      // engine 1.
      List<Config.Case> bodies = new ArrayList<>();
      if (spec.switchSpec() != null) {
        for (Config.SwitchEntry entry : spec.switchSpec().entries()) {
          bodies.add(entry.value());
        }
        bodies.add(spec.switchSpec().fallback());
      }
      if (spec.mix() != null) {
        bodies.addAll(spec.mix().cases());
      }
      List<Config.Switch> nested = new ArrayList<>();
      for (Config.Case body : bodies) {
        nestedSwitches(body, nested);
      }
      for (Config.Switch inner : nested) {
        if (caseCarriesPercent(inner.fallback())) {
          return spec.name();
        }
        for (Config.SwitchEntry entry : inner.entries()) {
          if (caseCarriesPercent(entry.value())) {
            return spec.name();
          }
        }
      }

      Config.Switch sw = spec.switchSpec();
      if (sw == null) {
        continue;
      }
      if (caseCarriesPercent(sw.fallback())) {
        return spec.name();
      }
      List<String> values = plainListValues(config, sw.on());
      for (Config.SwitchEntry entry : sw.entries()) {
        if (!caseCarriesPercent(entry.value())) {
          continue;
        }
        if (entry.keys().size() != 1 || values == null || !values.contains(entry.keys().get(0))) {
          return spec.name();
        }
      }
    }
    return null;
  }

  /** The values of a plain {@code <gen type="text" value="a,b,c">} sequence, or null. */
  private static List<String> plainListValues(Config config, String name) {
    for (Config.SequenceSpec spec : config.sequences()) {
      if (!name.equals(spec.name())) {
        continue;
      }
      Config.Gen gen = spec.gen();
      if (gen == null || !"text".equals(gen.type())) {
        return null;
      }
      if ("sequential".equals(gen.attrs().get("order"))
          || !trimmed(gen.attrs().get("repeat")).isEmpty()) {
        return null;
      }
      List<String> values = new ArrayList<>();
      for (String value : trimmed(gen.attrs().get("value")).split(",", -1)) {
        values.add(value.trim());
      }
      return values;
    }
    return null;
  }

  /**
   * Whether disk mode needs the exact engine rather than the streaming one.
   *
   * <p>Everything here is a case where a per-row answer and a whole-column answer differ: ANY
   * uniqueness, a child of a parent whose values are not a finite list, a weighted choice inside
   * a pattern. Ordinary exact percentages, switch, distinct and text parent-child all stream.
   */
  public static boolean needsExact(Config config) {
    return exactReason(config) != null;
  }

  /** Why disk mode needs the exact engine, in words; null when it does not. */
  private static String exactReason(Config config) {
    Map<String, Config.SequenceSpec> byName = new HashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      byName.put(spec.name(), spec);
    }

    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.uniq()) {
        return "uniq=\"true\" on \"" + spec.name() + "\"";
      }
      boolean weighted = spec.gen() != null && isWeightedAdvancedRegex(spec.gen());
      for (Config.Field field : fieldsOf(spec)) {
        weighted |= isWeightedAdvancedRegex(field.gen());
      }
      if (weighted) {
        return "\"" + spec.name() + "\" has a weighted choice in advanced_regex";
      }
      String parent = trimToNull(spec.parent());
      if (parent != null && !parentIsFiniteText(byName, parent)) {
        return "\"" + spec.name() + "\" has parent=\"" + parent + "\", which is not a list of values";
      }
    }
    // A group REARRANGES the columns it covers — every column keeps its multiset, so every
    // declared share survives — and that cannot be decided a row at a time. The streaming engine
    // could only offer a different answer, and two answers from one seed is the thing this whole
    // design exists to prevent.
    if (!config.envUniqGroups().isEmpty()) {
      List<String> names = new ArrayList<>();
      for (String name : config.envUniqGroups().get(0)) {
        names.add("\"" + name + "\"");
      }
      return "a <uniq> group over " + String.join(", ", names);
    }
    return null;
  }

  private static boolean parentIsFiniteText(
      Map<String, Config.SequenceSpec> byName, String reference) {
    int dot = reference.indexOf('.');
    Config.SequenceSpec parent = byName.get(dot < 0 ? reference : reference.substring(0, dot));
    return parent != null && parent.gen() != null && "text".equals(parent.gen().type());
  }

  private static boolean isWeightedAdvancedRegex(Config.Gen gen) {
    return "advanced_regex".equals(gen.type())
        && AdvancedRegexGen.hasWeightedChoice(gen.attr("value", ""));
  }

  private static boolean hasPercent(Config.Gen gen) {
    String percent = gen.attrs().get("percent");
    return percent != null && !percent.isEmpty();
  }



  /** {@code common.vehicle.model.${{Brand}}} — an address that is not known until the row is. */
  private static boolean isDynamic(String value) {
    return value.contains("${{");
  }

  /** Every {@code <gen>} in the config, simple or a compound's field. */
  /** A counter is unique by construction, so uniq on it needs no whole-column draw. */
  private static boolean counting(String type) {
    return "increment".equals(type) || "decrement".equals(type);
  }

  /** The first sequence holding a {@code <gen>} — simple or a compound's field — that passes. */
  private static String genOwner(Config config, Predicate<Config.Gen> test) {
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.gen() != null && test.test(spec.gen())) {
        return spec.name();
      }
      for (Config.Field field : fieldsOf(spec)) {
        if (field.gen() != null && test.test(field.gen())) {
          return spec.name();
        }
      }
    }
    return null;
  }

  /** A compound's fields, or nothing — a simple sequence has none rather than an empty list. */
  private static List<Config.Field> fieldsOf(Config.SequenceSpec spec) {
    return spec.isCompound() ? spec.fields() : List.of();
  }

  private static String trimToNull(String value) {
    if (value == null) {
      return null;
    }
    String trimmed = value.trim();
    return trimmed.isEmpty() ? null : trimmed;
  }
}
