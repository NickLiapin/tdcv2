package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.date.Calendar;
import io.github.nickliapin.tdc.date.DateFormatter;
import io.github.nickliapin.tdc.date.DateStep;
import io.github.nickliapin.tdc.date.PlainDateTime;
import io.github.nickliapin.tdc.generators.DateOffset;
import io.github.nickliapin.tdc.generators.Formula;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * A formula or a date offset standing in a BRANCH — inside a {@code <case>}, or as one of the
 * {@code <gen if="…">} branches of a sequence — rather than as a whole column.
 *
 * <p>Of the four derived constructs, these two read nothing but their own row. So a branch can
 * have them as cheaply as a whole column can: for each row the branch holds, compute that row.
 * Before this class, a date offset in a branch lost {@code of=} and {@code plus=} without a word
 * and drew an unrelated date, and a formula stopped the run with {@code generator type "formula"
 * is not ported yet} after {@code check} had called the config valid.
 *
 * <p>{@code running}, {@code stat}, a formula that reads {@code prev()} and a pool reference are
 * whole columns by nature, and the validator keeps them out of branches (TDC295, TDC268). They
 * never reach here.
 */
final class BranchDerived {
  private BranchDerived() {}

  /** A formula, or a date measured from another column: the two that read only their row. */
  static boolean isRowLocal(Config.Gen gen) {
    return gen != null && ("formula".equals(gen.type()) || DateOffset.isOffset(gen));
  }

  /** The branch's values, one per position — {@code ""} for a row the build will not keep. */
  static List<String> values(
      Config.Gen gen,
      int count,
      Prng.Sfc32 prng,
      String locale,
      PerRow.Stream stream,
      MemoryEngine.Siblings siblings,
      List<Long> instants) {
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add("");
    }
    if ("formula".equals(gen.type())) {
      String source = gen.attr("expr", "").trim();
      if (source.isEmpty()) {
        return out; // no expr= — the validator reports it
      }
      Integer decimals = Formula.decimalsOf(gen.attrs());
      for (int i = 0; i < count; i++) {
        final int row = stream == null ? i : stream.rowAt(i);
        if (stream != null && !stream.keeps(row)) {
          continue;
        }
        // A column this row does not have leaves the cell empty, as it does for a formula that
        // is a whole column: a zero nobody generated is not an answer. No previous row: prev()
        // makes a formula a whole column, which TDC295 keeps out of a branch.
        String answer =
            Formula.valueAtRow(
                source,
                decimals,
                row,
                name -> siblings != null && siblings.has().test(name),
                name -> siblings == null ? null : siblings.at().apply(name, row));
        out.set(i, answer == null ? "" : answer);
      }
      return out;
    }

    // A date offset: the same measurement the whole-column offset makes, row by row. A ranged
    // plus= draws its step from the row's own stream — (seed, stream, row) — so the step a row
    // gets does not depend on which other rows the branch holds.
    Long[] stamps = new Long[count];
    String source = DateOffset.sourceOf(gen.attrs());
    DateStep.OffsetResult parsed = DateStep.parseOffset(gen.attrs().get("plus"));
    if (siblings != null && siblings.has().test(source) && parsed.ok()) {
      DateStep.OffsetSpec offset = parsed.offset();
      String format = gen.attr("format", "").trim();
      format = format.isEmpty() ? "L" : format;
      Long[] kept =
          stream == null || stream.instants() == null ? null : stream.instants().get(source);
      String column = stream == null ? "" : stream.id().split("#", -1)[0];
      for (int i = 0; i < count; i++) {
        int row = stream == null ? i : stream.rowAt(i);
        if (stream != null && !stream.keeps(row)) {
          continue;
        }
        String text = siblings.at().apply(source, row);
        if (text == null || text.trim().isEmpty()) {
          continue;
        }
        PlainDateTime start = DateOffset.startOfRow(column, gen.attrs(), kept, row, text);
        if (start == null) {
          continue;
        }
        Prng.Sfc32 draw = stream == null ? prng : PerRow.rowGenerator(stream, row);
        PlainDateTime landed =
            DateStep.applyOffset(start, offset, DateOffset.drawSteps(offset, draw));
        stamps[i] = Calendar.toEpochMillis(landed);
        out.set(i, DateFormatter.format(landed, format, locale));
      }
    }
    if (instants != null) {
      instants.addAll(java.util.Arrays.asList(stamps));
    }
    return out;
  }

  /**
   * Every column some date offset measures from, wherever the offset stands — a whole column, a
   * {@code <case>} at any depth, an {@code if=} branch. Those columns keep the instant they
   * generated, so the offset works from the value whatever {@code format=} spelled it as.
   */
  static Set<String> offsetSources(Config config) {
    Set<String> out = new LinkedHashSet<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      visit(spec.gen(), out);
      if (spec.branches() != null) {
        for (Config.Branch branch : spec.branches()) {
          visit(branch.gen(), out);
        }
      }
      if (spec.mix() != null) {
        for (Config.Case c : spec.mix().cases()) {
          visitCase(c, out);
        }
      }
      if (spec.switchSpec() != null) {
        visitSwitch(spec.switchSpec(), out);
      }
    }
    return out;
  }

  private static void visit(Config.Gen gen, Set<String> out) {
    if (DateOffset.isOffset(gen)) {
      out.add(DateOffset.sourceOf(gen.attrs()));
    }
  }

  private static void visitCase(Config.Case c, Set<String> out) {
    for (Config.CasePart part : c.parts()) {
      if (part.gen() != null) {
        visit(part.gen(), out);
      } else if (part.mix() != null) {
        for (Config.Case inner : part.mix().cases()) {
          visitCase(inner, out);
        }
      } else if (part.switchSpec() != null) {
        visitSwitch(part.switchSpec(), out);
      }
    }
  }

  private static void visitSwitch(Config.Switch sw, Set<String> out) {
    for (Config.SwitchEntry entry : sw.entries()) {
      visitCase(entry.value(), out);
    }
    if (sw.fallback() != null) {
      visitCase(sw.fallback(), out);
    }
  }
}
