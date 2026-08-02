package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * One run split across threads.
 *
 * <p>A TDC run is the easy case for this. The streaming engine keys every draw by {@code
 * seed|stream|index}, so row nine million is a function of its own number and needs to know nothing
 * about row eight million. A shard can therefore be computed with no coordination at all — which is
 * the entire reason the seekable generator exists.
 *
 * <p>Each worker builds its own engine from the same config and writes rows {@code [start, stop)}
 * to its own temporary file; the caller's file then receives them in order. That the pieces join
 * into exactly the bytes one thread would have written is a property of {@link
 * StreamEngine#renderRows}, not of luck: the opening and closing fixtures belong to the shards that
 * own the first and last row, and the between-blocks delimiter is keyed to the global row number.
 *
 * <p>Each worker also gets its OWN {@link DataPacks}. Packs cache what they load in a plain map,
 * and a map being filled from several threads at once is a data race — one that would show up as a
 * corrupted value in one row of a hundred million, which is the worst kind of bug to go looking
 * for. Loading a pack twice is cheap; finding that bug is not.
 *
 * <p>Only the streaming engine qualifies. The in-memory engine holds the whole run anyway, so
 * splitting it would multiply the memory rather than the throughput, and the exact engine carries
 * state across rows that a shard cannot reconstruct. Both fall back to one thread, which is a
 * slower answer and never a wrong one.
 */
public final class Parallel {

  /**
   * Below this, a thread costs more to start than its rows cost to generate.
   *
   * <p>Threads are cheaper than the processes Python needs, but a worker still parses the config
   * and loads its packs before it renders anything.
   */
  public static final int MIN_ROWS = 100_000;

  private Parallel() {}

  /** One worker per core bar one, so the machine stays usable while a run is going. */
  public static int defaultWorkers() {
    return Math.max(1, Runtime.getRuntime().availableProcessors() - 1);
  }

  /**
   * How many workers to actually use.
   *
   * <p>Safe to decide from the hardware because the worker count NEVER changes the output — unlike
   * the engine, which has to be chosen from the config.
   */
  public static int resolveWorkers(Integer explicit, boolean canSplit, int count) {
    if (explicit != null) {
      return canSplit ? Math.max(1, explicit) : 1;
    }
    if (!canSplit || count < MIN_ROWS) {
      return 1;
    }
    return defaultWorkers();
  }

  /** Whether this run can be split at all. */
  public static boolean canSplit(Config config, DataPacks packs) {
    return EngineRouter.resolve(config, packs) == 2;
  }

  /** Contiguous, balanced ranges covering {@code [0, count)}; the first few get one extra row. */
  public static List<int[]> shards(int count, int workers) {
    int n = Math.max(1, Math.min(workers, Math.max(1, count)));
    int base = count / n;
    int remainder = count % n;
    List<int[]> out = new ArrayList<>(n);
    int start = 0;
    for (int i = 0; i < n; i++) {
      int end = start + base + (i < remainder ? 1 : 0);
      out.add(new int[] {start, end});
      start = end;
    }
    return out;
  }

  /**
   * Render the whole run into {@code target} using {@code workers} threads.
   *
   * @param packsFor builds a fresh {@link DataPacks} for a worker — see the note about caches above
   */
  public static void writeFile(
      Config config,
      java.util.function.Supplier<DataPacks> packsFor,
      long nowMillis,
      Path baseDir,
      Path target,
      int workers,
      int count) {
    List<int[]> ranges = shards(count, workers);
    Path scratch;
    try {
      scratch = Files.createTempDirectory("tdcv2-shards-");
    } catch (IOException e) {
      throw new UncheckedIOException("cannot create a scratch directory for parallel output", e);
    }

    // Shut down by hand rather than with try-with-resources: ExecutorService only became
    // AutoCloseable in Java 19, and this has to build on the version the project targets.
    ExecutorService pool = Executors.newFixedThreadPool(ranges.size());
    try {
      List<Future<Path>> pending = new ArrayList<>(ranges.size());
      for (int i = 0; i < ranges.size(); i++) {
        int[] range = ranges.get(i);
        Path piece = scratch.resolve("part-" + i);
        pending.add(
            pool.submit(
                () -> {
                  try (Writer out =
                      new BufferedWriter(
                          new OutputStreamWriter(
                              Files.newOutputStream(piece), StandardCharsets.UTF_8),
                          1 << 16)) {
                    StreamEngine.renderRows(
                        config, packsFor.get(), nowMillis, baseDir, out, range[0], range[1]);
                  }
                  return piece;
                }));
      }

      try (OutputStream out =
          new java.io.BufferedOutputStream(Files.newOutputStream(target), 1 << 16)) {
        for (Future<Path> future : pending) {
          Files.copy(future.get(), out);
        }
      } catch (IOException e) {
        throw new UncheckedIOException("cannot write " + target, e);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("interrupted while generating", e);
      } catch (ExecutionException e) {
        // A worker's failure is the run's failure; unwrap it so the caller sees the real cause.
        Throwable cause = e.getCause();
        if (cause instanceof RuntimeException runtime) {
          throw runtime;
        }
        throw new IllegalStateException("a worker failed", cause);
      }
    } finally {
      pool.shutdownNow();
      deleteTree(scratch);
    }
  }

  private static void deleteTree(Path root) {
    try (var walk = Files.walk(root)) {
      walk.sorted(java.util.Comparator.reverseOrder()).forEach(Parallel::deleteQuietly);
    } catch (IOException ignored) {
      // A leftover scratch directory in the system temp folder is not worth failing a finished run.
    }
  }

  private static void deleteQuietly(Path path) {
    try {
      Files.deleteIfExists(path);
    } catch (IOException ignored) {
      // Same reasoning as above.
    }
  }
}
