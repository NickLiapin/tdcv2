package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.generators.Repeat;
import io.github.nickliapin.tdc.prng.Permute;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Seekable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code repeat=} built in memory the way the streaming engine builds it.
 *
 * <p>A repeating column has two plans, not one. How MANY values a row keeps is an exact quota over
 * the run — permuted by {@code #replen}, so a row's length follows from its own position and never
 * from a running total over its predecessors. What those values ARE then depends on the generator:
 * a list is laid out over the whole slot space and read at the row's slots, while anything drawn
 * takes one seekable sub-stream per element, {@code #e0}, {@code #e1}, and so on.
 *
 * <p>Both halves are keyed by {@code (seed, streamId)} and mirror the reference's {@code
 * repeat-keyed.ts}. The older sequential builder in {@link Repeat#build} stays for the cases with
 * nothing to key by — an inline generator inside a pack body.
 */
final class RepeatKeyed {

  private RepeatKeyed() {}

  /** One element of one row: its own generator, and a one-slot flag for {@code anomaly=}. */
  interface Element {
    String build(int k, Prng.Sfc32 prng, boolean[] flag);
  }

  /** One element of a LISTED row: the row it belongs to, its raw value, and its index in the row. */
  interface Modifier {
    String apply(int row, String value, int k);
  }

  /**
   * A repeating column of DRAWN values.
   *
   * <p>Element k of a row comes off the row's own {@code #e{k}} stream, so the row still resolves
   * alone — which is also what lets a worker render a range of rows without seeing the rest.
   */
  static List<String> buildDraws(
      Repeat.Spec spec,
      int count,
      PerRow.Stream stream,
      String genType,
      Element element,
      List<String> flagTextOut) {
    Repeat.Plan plan = lengthPlan(spec, count, stream);
    int key = Permute.key(stream.seed(), stream.id() + "#replen");
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      int row = stream.rowAt(i);
      int keep = plan.lengthAt(Permute.permute(i, count, key));
      List<String> parts = new ArrayList<>(keep);
      List<String> marks = new ArrayList<>(keep);
      for (int k = 0; k < keep; k++) {
        boolean[] flag = new boolean[1];
        final int at = k;
        final int atRow = row;
        // A drawn generator has no pool to draw down, so `distinct` is rejection sampling on
        // fresh sub-streams — the same ids the reference uses, so the two agree value for value.
        java.util.function.Function<String, String> drawAt =
            suffix ->
                element.build(
                    at,
                    Seekable.generator(stream.seed(), stream.id() + "#e" + at + suffix, atRow),
                    flag);
        parts.add(
            spec.distinct()
                ? Repeat.redrawUntilFresh(parts, genType, drawAt)
                : drawAt.apply(""));
        marks.add(flag[0] ? "true" : "false");
      }
      out.add(Repeat.join(parts, spec));
      // A parallel list of true/false, never a running total — accumulating it would mean nothing
      // — so it joins with the separator alone.
      if (flagTextOut != null) {
        flagTextOut.add(String.join(spec.separator(), marks));
      }
    }
    return out;
  }

  /**
   * A repeating column of LISTED values.
   *
   * <p>The slot space covers every element of every row at once, laid out exactly and permuted; a
   * row reads the slots its length plan gave it.
   */
  static List<String> buildLayout(
      Repeat.Spec spec,
      List<String> values,
      double[] percents,
      int count,
      PerRow.Stream stream,
      Modifier modify) {
    Repeat.Plan plan = lengthPlan(spec, count, stream);
    int lengthKey = Permute.key(stream.seed(), stream.id() + "#replen");
    int slots = plan.totalSlots();
    int[] counts =
        Hamilton.countsPerValue(
            slots, percents, Prng.create(stream.seed() + "|" + stream.id() + "|pct"));
    int key = Permute.key(stream.seed(), stream.id());

    int[] cumHi = new int[counts.length];
    int acc = 0;
    for (int i = 0; i < counts.length; i++) {
      acc += counts[i];
      cumHi[i] = acc;
    }

    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      int p = Permute.permute(i, count, lengthKey);
      int row = stream.rowAt(i);
      int start = plan.slotStartAt(p);
      int keep = plan.lengthAt(p);
      List<String> parts = new ArrayList<>(keep);
      // `distinct` leaves the whole-run layout behind: a row that must not repeat itself has to
      // CHOOSE from the pool, and a choice cannot be read off a pre-laid-out slot. One uniform
      // per pick off the row's own stream, budgeted at the maximum length, so the row still
      // resolves alone.
      if (spec.distinct()) {
        double[] draws = Seekable.uniforms(stream.seed(), stream.id() + "#dist", row, spec.max());
        int[] at = {0};
        List<String> picked =
            Repeat.drawDistinct(
                values,
                percents,
                keep,
                () -> at[0] < draws.length ? draws[at[0]++] : 1.0,
                "the value list");
        for (int k = 0; k < picked.size(); k++) {
          String raw = picked.get(k);
          parts.add(modify == null ? raw : modify.apply(row, raw, k));
        }
      } else {
        for (int k = 0; k < keep; k++) {
          String raw = valueForSlot(values, cumHi, Permute.permute(start + k, slots, key));
          parts.add(modify == null ? raw : modify.apply(row, raw, k));
        }
      }
      out.add(Repeat.join(parts, spec));
    }
    return out;
  }

  /**
   * The {@code anomaly=}/{@code missing=} draw for one element of a repeating LISTED column.
   *
   * <p>One draw per element, pulled a whole row at a time — the budget is the row's maximum length,
   * so which uniform element k gets does not depend on how long its row turned out.
   */
  static ElementDraw elementUniforms(PerRow.Stream stream, String purpose, int budget) {
    String id = stream.id() + purpose;
    Map<Integer, double[]> cache = new HashMap<>(1);
    return (row, k) -> {
      double[] drawn = cache.get(row);
      if (drawn == null) {
        drawn = Seekable.uniforms(stream.seed(), id, row, budget);
        cache.clear();
        cache.put(row, drawn);
      }
      return k < drawn.length ? drawn[k] : 1.0;
    };
  }

  /** The uniform element {@code k} of {@code row} gets. */
  interface ElementDraw {
    double at(int row, int k);
  }

  /** How many values each position keeps, and where in the slot space they start. */
  private static Repeat.Plan lengthPlan(Repeat.Spec spec, int count, PerRow.Stream stream) {
    int[] counts =
        Hamilton.countsPerValue(
            count,
            Repeat.lengthPercents(spec),
            Prng.create(stream.seed() + "|" + stream.id() + "|replen"));
    return Repeat.plan(spec, count, counts);
  }

  private static String valueForSlot(List<String> values, int[] cumHi, int slot) {
    int lo = 0;
    int hi = cumHi.length - 1;
    while (lo < hi) {
      int mid = (lo + hi) / 2;
      if (slot < cumHi[mid]) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo < values.size() ? values.get(lo) : "";
  }
}
