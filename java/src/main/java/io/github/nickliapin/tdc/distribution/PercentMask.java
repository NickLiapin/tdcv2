package io.github.nickliapin.tdc.distribution;

import java.util.ArrayList;
import java.util.List;

/**
 * Reads a {@code percent="..."} mask into one number per value.
 *
 * <p>A mask does not have to be complete. Blank entries share whatever is left of 100 evenly, so
 * {@code percent="50"} across three values means "50, then split the rest" rather than an error —
 * which is what makes it usable when only one share actually matters to the config.
 *
 * <p>Where the blanks go depends on the mask: a leading comma pins the first entry and pads
 * after it, so {@code percent="10,,20"} and {@code percent=",20"} land differently on purpose.
 */
public final class PercentMask {

  /**
   * Which way a percent mask is wrong.
   *
   * <p>Three different mistakes, and each gets its own diagnostic code: a mask with the wrong
   * number of entries, one holding something that is not a share, and one whose shares do not
   * add up. They call for three different fixes, and one code for all of them would say only
   * that the mask is wrong.
   */
  public enum Kind {
    LENGTH,
    NUMBER,
    SUM
  }

  /** A percent mask that cannot be used, and the reason in a form a caller can branch on. */
  public static final class MaskException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;
    private final Kind kind;

    MaskException(String message, Kind kind) {
      super(message);
      this.kind = kind;
    }

    public Kind kind() {
      return kind;
    }
  }


  private static final double TOLERANCE = 0.0001;

  private PercentMask() {}

  public static double[] expand(String mask, int valueCount) {
    if (valueCount <= 0) {
      throw new IllegalArgumentException("percent mask requires at least one value");
    }
    List<String> parts = normalize(mask, valueCount);

    double[] fixed = new double[parts.size()];
    List<Integer> blanks = new ArrayList<>();
    double fixedSum = 0;
    for (int i = 0; i < parts.size(); i++) {
      String part = parts.get(i);
      if (part.isEmpty()) {
        blanks.add(i);
        continue;
      }
      double n;
      try {
        n = Double.parseDouble(part);
      } catch (NumberFormatException e) {
        throw new MaskException("percent contains a non-numeric or negative value", Kind.NUMBER);
      }
      if (n < 0 || Double.isInfinite(n) || Double.isNaN(n)) {
        throw new MaskException("percent contains a non-numeric or negative value", Kind.NUMBER);
      }
      fixed[i] = n;
      fixedSum += n;
    }

    if (fixedSum > 100 + TOLERANCE) {
      throw new MaskException("percent values sum to " + fixedSum + ", expected <= 100", Kind.SUM);
    }
    if (blanks.isEmpty()) {
      if (Math.abs(fixedSum - 100) > TOLERANCE) {
        throw new MaskException("percent values sum to " + fixedSum + ", expected 100", Kind.SUM);
      }
      return fixed;
    }
    double remainder = (100 - fixedSum) / blanks.size();
    for (int idx : blanks) {
      fixed[idx] = remainder;
    }
    return fixed;
  }

  private static List<String> normalize(String mask, int valueCount) {
    List<String> parts = new ArrayList<>();
    for (String s : mask.split(",", -1)) {
      parts.add(s.trim());
    }
    if (parts.size() > valueCount) {
      throw new MaskException(
          "percent has " + parts.size() + " entries but value has " + valueCount, Kind.LENGTH);
    }
    int missing = valueCount - parts.size();
    if (missing == 0) {
      return parts;
    }
    List<String> out = new ArrayList<>();
    if (mask.stripLeading().startsWith(",")) {
      // A leading comma means the first entry is anchored and the padding follows it.
      out.add(parts.get(0));
      for (int i = 0; i < missing; i++) {
        out.add("");
      }
      out.addAll(parts.subList(1, parts.size()));
    } else {
      out.addAll(parts);
      for (int i = 0; i < missing; i++) {
        out.add("");
      }
    }
    return out;
  }
}
