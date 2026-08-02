package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.generators.AdvancedRegexGen;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
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

  /** The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk. */
  public static int resolve(Config config, DataPacks packs) {
    String forced = trimToNull(config.engine());
    if (forced != null) {
      if (!"1".equals(forced) && !"2".equals(forced) && !"3".equals(forced)) {
        throw new IllegalArgumentException(
            "invalid engine \""
                + forced
                + "\" — expected \"1\" (in-memory), \"2\" (streaming), or \"3\" (exact-on-disk)");
      }
      return Integer.parseInt(forced);
    }
    String mode = trimToNull(config.mode());
    if ("memory".equals(mode)) {
      return 1;
    }
    // "stream" is the old name for asking for Engine 2 outright, from before mode described the
    // constraint rather than the engine. Kept working; the router is not consulted.
    if ("stream".equals(mode)) {
      return 2;
    }
    if (mode != null && !"disk".equals(mode)) {
      throw new IllegalArgumentException(
          "invalid mode \"" + mode + "\" — expected \"memory\" or \"disk\"");
    }
    // No mode at all means disk: a config says how big its run is, not how to hold it, and the
    // engine that can stream is the right default for a generator whose whole point is volume.

    // A template address that names a field resolves per row against the other columns; only
    // the in-memory engine has them all.
    if (anyGen(config, gen -> "template".equals(gen.type()) && isDynamic(gen.attr("value", "")))) {
      return 1;
    }
    // weight= with row= draws a linked record to an exact quota, which needs the global total.
    if (anyGen(
        config,
        gen ->
            "file".equals(gen.type())
                && trimToNull(gen.attrs().get("weight")) != null
                && trimToNull(gen.attrs().get("row")) != null)) {
      return 1;
    }
    // A pack generator that declares its own shares apportions them over the whole column.
    if (packs != null && anyGen(config, gen -> declaresShares(gen, config, packs))) {
      return 1;
    }
    // A network call is not reproducible, so it never runs on the reproducible path.
    // uniq on a simple sequence draws WITHOUT REPLACEMENT — the pool and the
    // taken-set span the whole column, which only the in-memory engine holds.
    if (config.sequences().stream()
        .anyMatch(
            s ->
                s.uniq()
                    && (s.gen() != null
                        ? !counting(s.gen().type())
                        : s.items() != null
                            && s.items().stream()
                                .anyMatch(
                                    i ->
                                        i.gen() != null
                                            && i.field() == null
                                            && !counting(i.gen().type()))))) {
      return 1;
    }
    if (anyGen(config, gen -> "http".equals(gen.type()))) {
      return 1;
    }
    return needsExact(config) ? 3 : 2;
  }

  /**
   * Whether disk mode needs the exact engine rather than the streaming one.
   *
   * <p>Everything here is a case where a per-row answer and a whole-column answer differ: exact
   * percentages combined with uniqueness, a uniq field that is not a finite list, a child of a
   * parent whose values are not a finite list, a weighted choice inside a pattern. Ordinary
   * exact percentages, uniform uniqueness, switch, distinct and text parent-child all stream.
   */
  public static boolean needsExact(Config config) {
    Map<String, Config.SequenceSpec> byName = new HashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      byName.put(spec.name(), spec);
    }

    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.uniq()) {
        if (trimToNull(spec.parent()) != null) {
          return true;
        }
        for (Config.Field field : fieldsOf(spec)) {
          if (!"text".equals(field.gen().type()) || hasPercent(field.gen())) {
            return true;
          }
        }
      }
      if (spec.gen() != null && isWeightedAdvancedRegex(spec.gen())) {
        return true;
      }
      for (Config.Field field : fieldsOf(spec)) {
        if (isWeightedAdvancedRegex(field.gen())) {
          return true;
        }
      }
      String parent = trimToNull(spec.parent());
      if (parent != null && !parentIsFiniteText(byName, parent)) {
        return true;
      }
    }
    return false;
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

  private static boolean declaresShares(Config.Gen gen, Config config, DataPacks packs) {
    if (!"template".equals(gen.type())) {
      return false;
    }
    String path = gen.attr("value", "");
    if (path.isEmpty() || isDynamic(path)) {
      return false;
    }
    String locale = gen.attrs().get("local");
    try {
      return packs.needsWholeColumn(path, locale == null || locale.isBlank() ? config.locale() : locale);
    } catch (RuntimeException e) {
      // An address that does not resolve is the validator's problem, not the router's.
      return false;
    }
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

  private static boolean anyGen(Config config, Predicate<Config.Gen> test) {
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.gen() != null && test.test(spec.gen())) {
        return true;
      }
      for (Config.Field field : fieldsOf(spec)) {
        if (field.gen() != null && test.test(field.gen())) {
          return true;
        }
      }
    }
    return false;
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
