package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.generators.FileGen;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.prng.Prng;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * {@code uniq="true"} on a SIMPLE sequence: every row gets a different value.
 *
 * <p>A compound's uniq rearranges what was already drawn — it can keep the per-value proportions
 * because a tuple has room to vary. A single column has no such room: proportions and uniqueness
 * contradict each other the moment any value's share exceeds one row. So here uniq changes the
 * DRAW itself: values are sampled WITHOUT REPLACEMENT. A weighted pool keeps its meaning —
 * frequent values are more likely to make the cut — but nothing appears twice.
 *
 * <p>Draw budget: exactly one PRNG draw per pick, whatever the pool. The reference is
 * {@code typescript/src/sequence/uniq-simple.ts}; the numbers here must match it byte for byte.
 */
public final class UniqSimple {

  private static final Pattern INT_RANGE = Pattern.compile("^\\s*(-?\\d+)\\s*\\.\\.\\s*(-?\\d+)\\s*$");

  private UniqSimple() {}

  /** {@code count} pairwise-different values, or a refusal that names both numbers. */
  public static List<String> build(
      String name,
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      DataPacks packs,
      String locale,
      Path baseDir) {
    if ("number".equals(gen.type())) {
      return uniqueNumbers(name, gen, count, prng);
    }
    Pool pool = poolOf(name, gen, packs, locale, baseDir);
    if (pool.values.size() < count) {
      throw new IllegalStateException(
          "uniq: sequence \"" + name + "\" cannot produce " + count
              + " unique values — its source holds only " + pool.values.size()
              + " distinct values. Add more values, or lower the count.");
    }
    return sampleWithoutReplacement(pool, count, prng);
  }

  /** One draw per pick: a point in the remaining total weight, walked in pool order. */
  private static List<String> sampleWithoutReplacement(Pool pool, int count, Prng.Sfc32 prng) {
    double[] weights = pool.weights;
    double total = 0.0;
    for (double w : weights) {
      total += w;
    }
    boolean[] taken = new boolean[weights.length];
    List<String> out = new ArrayList<>(count);
    for (int k = 0; k < count; k++) {
      double target = prng.next() * total;
      double acc = 0.0;
      int picked = -1;
      for (int i = 0; i < weights.length; i++) {
        if (taken[i]) {
          continue;
        }
        acc += weights[i];
        if (target < acc) {
          picked = i;
          break;
        }
      }
      // Floating summation can leave the target a hair past the last value's edge; the last
      // remaining value is the only honest answer then.
      if (picked < 0) {
        for (int i = weights.length - 1; i >= 0; i--) {
          if (!taken[i]) {
            picked = i;
            break;
          }
        }
      }
      if (picked < 0) {
        break;
      }
      taken[picked] = true;
      total -= weights[picked];
      out.add(pool.values.get(picked));
    }
    return out;
  }

  /** Unique integers from a plain {@code a..b} range: draw normally, redraw on a repeat. */
  private static List<String> uniqueNumbers(
      String name, Config.Gen gen, int count, Prng.Sfc32 prng) {
    long[] bounds = plainIntRange(gen);
    if (bounds == null) {
      throw new IllegalStateException(
          "uniq: sequence \"" + name + "\" — " + unsupportedReason(gen));
    }
    long lo = bounds[0];
    long hi = bounds[1];
    long size = hi - lo + 1;
    if (size < count) {
      throw new IllegalStateException(
          "uniq: sequence \"" + name + "\" cannot produce " + count
              + " unique values — the range " + lo + ".." + hi + " holds only " + size
              + " integers. Widen the range, or lower the count.");
    }
    Set<Long> seen = new HashSet<>();
    List<String> out = new ArrayList<>(count);
    while (out.size() < count) {
      long n = lo + (long) Math.floor(prng.next() * size);
      if (!seen.add(n)) {
        continue;
      }
      out.add(String.valueOf(n));
    }
    return out;
  }

  /** Why this gen cannot take the without-replacement path, for the refusal. */
  static String unsupportedReason(Config.Gen gen) {
    if ("number".equals(gen.type())) {
      return "its values are not a plain integer range — uniq supports value=\"a..b\" "
          + "without decimals=, distribution=, include=, exclude= or first_zero=";
    }
    return "its values cannot be enumerated (type=\"" + gen.type() + "\") — uniq on a simple "
        + "sequence supports text lists, template packs, file columns and plain integer ranges";
  }

  private static long[] plainIntRange(Config.Gen gen) {
    for (String blocked :
        new String[] {"distribution", "decimals", "include", "exclude", "first_zero"}) {
      if (!gen.attr(blocked, "").trim().isEmpty()) {
        return null;
      }
    }
    Matcher m = INT_RANGE.matcher(gen.attr("value", ""));
    if (!m.matches()) {
      return null;
    }
    long lo = Long.parseLong(m.group(1));
    long hi = Long.parseLong(m.group(2));
    return lo <= hi ? new long[] {lo, hi} : null;
  }

  /** The distinct values a gen can produce, with weights; duplicate strings merge. */
  private static Pool poolOf(
      String name, Config.Gen gen, DataPacks packs, String locale, Path baseDir) {
    switch (gen.type()) {
      case "text" -> {
        if (gen.attr("percent", "").trim().isEmpty()) {
          List<String> values = new ArrayList<>();
          for (String piece : gen.attr("value", "").split(",", -1)) {
            values.add(piece.trim());
          }
          return mergeDuplicates(values, null);
        }
      }
      case "template" -> {
        String path = gen.attr("value", "");
        if ("person.b_day".equals(path) || "date.range".equals(path)) {
          throw notAList(name, path);
        }
        // `local=` on the <gen> picks the pack here too -- a unique draw over a German
        // surname list must enumerate the German file, not the English one.
        String local = gen.attrs().get("local");
        DataPacks.Entry entry =
            packs.load(path, local == null || local.isBlank() ? locale : local);
        if (entry.isGenerator() || entry.values().isEmpty()) {
          throw notAList(name, path);
        }
        double[] weights = entry.weighted() ? entry.percents() : null;
        return mergeDuplicates(entry.values(), weights);
      }
      case "file" -> {
        if (gen.attr("row", "").trim().isEmpty()) {
          FileGen.Weighted weighted = FileGen.loadWeighted(gen.attrs(), baseDir, packs.dataRoots());
          if (weighted != null) {
            return mergeDuplicates(weighted.values(), weighted.percents());
          }
          return mergeDuplicates(FileGen.load(gen.attrs(), baseDir, packs.dataRoots()), null);
        }
      }
      default -> {
        // Falls through to the refusal below.
      }
    }
    throw new IllegalStateException(
        "uniq: sequence \"" + name + "\" — " + unsupportedReason(gen));
  }

  private static IllegalStateException notAList(String name, String path) {
    return new IllegalStateException(
        "uniq: sequence \"" + name + "\" — template \"" + path + "\" does not resolve to a "
            + "value list, so its values cannot be enumerated for a unique draw");
  }

  /** Merge duplicate strings, summing weights (missing weights count as 1). */
  private static Pool mergeDuplicates(List<String> values, double[] weights) {
    Map<String, Integer> index = new HashMap<>();
    List<String> outValues = new ArrayList<>();
    List<Double> outWeights = new ArrayList<>();
    for (int i = 0; i < values.size(); i++) {
      String value = values.get(i);
      double weight = weights == null ? 1.0 : weights[i];
      Integer at = index.get(value);
      if (at == null) {
        index.put(value, outValues.size());
        outValues.add(value);
        outWeights.add(weight);
      } else {
        outWeights.set(at, outWeights.get(at) + weight);
      }
    }
    double[] flat = new double[outWeights.size()];
    for (int i = 0; i < flat.length; i++) {
      flat[i] = outWeights.get(i);
    }
    return new Pool(outValues, flat);
  }

  private record Pool(List<String> values, double[] weights) {}
}
