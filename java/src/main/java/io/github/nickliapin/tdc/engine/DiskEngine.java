package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import java.nio.file.Path;

/**
 * Engine 3: everything the in-memory engine does, for runs that do not fit in memory.
 *
 * <p>It is not a third implementation. It is the streaming engine with one setting changed — a
 * {@code uniq} sequence is built to its exact shares and then verified on disk, instead of being
 * given uniform combinations — and a fallback for the configs that setting cannot satisfy.
 *
 * <p>The fallback is the honest part. A config that turns out to need the whole column, or a
 * uniqueness constraint so tight the bounded repair cannot place every row, goes to the in-memory
 * engine and produces correct data at the cost of the memory profile. Which is the right trade:
 * an engine chosen for its memory behaviour must not answer differently from the one that was not.
 *
 * <p>Two things it must NOT do, and both used to happen here.
 *
 * <p>It must not fall back for a caller that NAMED this engine. {@code engine="3"} and
 * {@code --engine 3} say WHICH engine to run, so quietly running another hides exactly what the
 * author asked to be told — the rule the streaming engine has followed all along. Measured before
 * the fix: a tight {@code <uniq>} under {@code --engine 3} produced byte-identical output to
 * {@code --engine 1}, so anyone benchmarking engine 3 on a tight config was benchmarking engine 1.
 *
 * <p>And it must not fall back past what the in-memory engine can hold. There the fallback does
 * not fail fast; it fails after half an hour of materialising, out of memory, with nothing written.
 */
public final class DiskEngine {

  private DiskEngine() {}

  /** The run as addressable records, exact and bounded — or in memory when it cannot be both. */
  public static RowSource rows(Config config, DataPacks packs, long nowMillis, Path baseDir) {
    return rows(config, packs, nowMillis, baseDir, null);
  }

  /** The same, reporting what it is doing as it goes. */
  public static RowSource rows(
      Config config, DataPacks packs, long nowMillis, Path baseDir, Progress onProgress) {
    return rows(config, packs, nowMillis, baseDir, onProgress, false);
  }

  /**
   * The same, told whether the caller asked for this engine BY NAME rather than describing a
   * constraint.
   */
  public static RowSource rows(
      Config config,
      DataPacks packs,
      long nowMillis,
      Path baseDir,
      Progress onProgress,
      boolean named) {
    try {
      return StreamEngine.rows(config, packs, nowMillis, baseDir, true, onProgress);
    } catch (StreamEngine.Unsupported | ExactUniq.RepairNeeded e) {
      refuseIfItMust(e, config.count(), named && e instanceof ExactUniq.RepairNeeded);
      return MemoryEngine.build(config, packs, nowMillis, baseDir, onProgress);
    }
  }

  /**
   * Raise instead of falling back, in the two cases where falling back is the wrong answer.
   *
   * <p>{@code named} here means "named AND stopped by the repair cap". A shape the lazy path
   * cannot express at all — a weighted pack generator, say — means engine 3 never got to run the
   * config, and covering that is what engine 3 IS. The cap is the other case: engine 3 DID run
   * this config, got most of the way, and gave up on a memory budget — the very property the
   * caller named this engine to get.
   */
  static void refuseIfItMust(RuntimeException error, int count, boolean named) {
    // The refusals share a first half — up to the em dash — and differ in the advice after it.
    String said = error.getMessage().split(" — ", 2)[0];
    if (count > ExactUniq.IN_MEMORY_FALLBACK_MAX_ROWS) {
      throw new IllegalStateException(
          said
              + " — and at "
              + count
              + " rows the in-memory engine cannot take over. Widen the uniq columns' values"
              + " (more distinct names, wider ranges…) or lower the count.");
    }
    if (named) {
      throw new IllegalStateException(
          said
              + " — and engine 3 was asked for by name, so it refuses rather than quietly running"
              + " another engine. Remove the engine choice to let a uniq this tight go to the"
              + " in-memory engine, which is what has been happening here all along.");
    }
  }
}
