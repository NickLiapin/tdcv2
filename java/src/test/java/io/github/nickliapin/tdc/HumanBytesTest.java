package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.Test;

/**
 * Sizes people can read.
 *
 * <p>The bug this replaces: {@code pack list} divided by 1,048,576 and printed one decimal, so a
 * 3 KB pack and a 9 KB pack both read {@code 0.0 MB} and the whole catalogue looked like it
 * weighed nothing. These cases pin the boundaries, and the shared CLI fixture pins that all five
 * implementations agree.
 */
class HumanBytesTest {

  @Test
  void saysBytesInBytesRatherThanAFractionOfAKilobyte() {
    // The case that started this: below a kilobyte there IS no sensible fraction,
    // so the unit has to change instead of the precision.
    assertEquals("1 B", HumanBytes.format(1));
    assertEquals("800 B", HumanBytes.format(800));
    assertEquals("1023 B", HumanBytes.format(1023));
  }

  @Test
  void neverPrintsZeroPointZeroForAFileThatExists() {
    for (long n : new long[] {1, 9, 99, 512, 1024, 2710, 9999}) {
      assertFalse(HumanBytes.format(n).startsWith("0.0"), Long.toString(n));
    }
  }

  @Test
  void keepsADecimalBelowAHundred() {
    assertEquals("1.0 KB", HumanBytes.format(1024));
    assertEquals("2.6 KB", HumanBytes.format(2710)); // the smallest shipped pack
    assertEquals("10.0 KB", HumanBytes.format(10_240));
    assertEquals("96.7 KB", HumanBytes.format(99_000));
  }

  @Test
  void dropsTheDecimalAtAHundredWhereItIsNoise() {
    assertEquals("100 KB", HumanBytes.format(102_400));
    assertEquals("248 KB", HumanBytes.format(253_515)); // the largest shipped pack
  }

  @Test
  void climbsAUnitWhenItShould() {
    assertEquals("1.0 MB", HumanBytes.format(1_048_576));
    assertEquals("1.5 MB", HumanBytes.format(1_572_864));
    assertEquals("1.0 GB", HumanBytes.format(1_073_741_824L));
    assertEquals("32.0 GB", HumanBytes.format(34_359_738_368L));
    assertEquals("1.0 TB", HumanBytes.format(1_099_511_627_776L));
  }

  /** 1023.999 KB rounds to a whole 1024 KB, which nobody writes. */
  @Test
  void promotesRatherThanPrinting1024OfAUnit() {
    assertEquals("1.0 GB", HumanBytes.format(1_073_741_823L));
    assertEquals("1.0 MB", HumanBytes.format(1_048_575));
  }

  @Test
  void answersANonsenseNumberInsteadOfThrowingAtIt() {
    assertEquals("0 B", HumanBytes.format(0));
    assertEquals("0 B", HumanBytes.format(-1));
  }
}
