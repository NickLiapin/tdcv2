package io.github.nickliapin.tdc.date;

/**
 * A calendar instant with no zone attached.
 *
 * <p>Everything in TDC's date handling is UTC. A generator that quietly used the machine's
 * zone would produce different data in Moscow and in Denver from the same seed, which is the
 * one thing the product promises never happens.
 */
public record PlainDateTime(
    int year, int month, int day, int hour, int minute, int second, int millisecond) {

  public PlainDateTime startOfDay() {
    return new PlainDateTime(year, month, day, 0, 0, 0, 0);
  }
}
