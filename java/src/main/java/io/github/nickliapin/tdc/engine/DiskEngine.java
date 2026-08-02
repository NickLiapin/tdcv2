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
 */
public final class DiskEngine {

  private DiskEngine() {}

  /** The run as addressable records, exact and bounded — or in memory when it cannot be both. */
  public static RowSource rows(Config config, DataPacks packs, long nowMillis, Path baseDir) {
    try {
      return StreamEngine.rows(config, packs, nowMillis, baseDir, true);
    } catch (StreamEngine.Unsupported | ExactUniq.RepairNeeded e) {
      return MemoryEngine.build(config, packs, nowMillis, baseDir);
    }
  }
}
