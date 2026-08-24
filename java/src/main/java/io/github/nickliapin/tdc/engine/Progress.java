package io.github.nickliapin.tdc.engine;

/**
 * What a run says about itself while it is still going.
 *
 * <p>A large run is silent for minutes at a time, and silence reads the same as a hang. This is the
 * channel that tells them apart: it is called as the work advances, about two hundred times per
 * phase, so it must be cheap. Whoever wants it durable — the command line writes a small JSON file
 * — throttles it themselves.
 *
 * <p>The phases, in the order a uniq run passes through them: {@code uniq-scan} (every row's tuple
 * hashed into its pile), {@code uniq-sort} (the piles sorted), {@code render} (rows written). A run
 * without uniqueness only ever reports {@code render}.
 */
@FunctionalInterface
public interface Progress {

  /**
   * One report.
   *
   * @param phase which of the three phases is running
   * @param done how much of it is finished
   * @param total how much there is — {@code done} counts up to this
   */
  void report(String phase, int done, int total);
}
