package io.github.nickliapin.tdc.generators;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.IntFunction;

/**
 * One {@code <gen type="http">} as a column of the run, fetched batch by batch.
 *
 * <p>The rule {@code http} runs on: the column is cut into batches of {@code batch=} rows,
 * numbered by the ABSOLUTE row of the run — batch k is rows [k·N, (k+1)·N). Wherever the
 * generator sits — a sequence of its own, a {@code parent=} child, a {@code <mix>} case, a field
 * — row i reads answer i, and the service is asked only for the batches somebody reads.
 *
 * <p>The in-memory engine asks for a whole column of rows at once; a reader walking row by row
 * finds the batch already fetched or on the wire. Memory holds a few batches, never the column.
 *
 * <p>{@code parallel=} is how many batches may be on the wire together. The default, 1, still
 * overlaps the network with the engine's own work: the next batch is requested the moment the
 * current one arrives, while its rows are written.
 *
 * <p>Mirrors {@code typescript/src/generators/http-column.ts}.
 */
public final class HttpColumn {

  /** Rows per request when {@code batch=} is absent — see the TypeScript twin for why. */
  public static final int DEFAULT_BATCH = 10_000;

  /** Everything one http generator needs, resolved once per run. */
  public record Spec(
      String sequence,
      String src,
      String inName,
      String seed,
      String secret,
      HttpGen.OnError onError,
      long timeoutMs,
      int batch,
      int parallel) {}

  /** A failed batch, worded for the reader — the sequence, the service and the rows. */
  public static final class ColumnException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    ColumnException(String message, Throwable cause) {
      super(message, cause);
    }
  }

  private record InFlight(CompletableFuture<List<String>> future, int offset, int count) {}

  /** Request threads are daemons: a finished run must never wait on one to exit. */
  private static final ExecutorService POOL =
      Executors.newCachedThreadPool(
          task -> {
            Thread thread = new Thread(task, "tdc-http");
            thread.setDaemon(true);
            return thread;
          });

  private final Spec spec;
  private final int total;
  private final int batches;
  private final Map<Integer, InFlight> inFlight = new HashMap<>();
  /** Answered batches, oldest first; trimmed to {@link #keep}. */
  private final LinkedHashMap<Integer, List<String>> answered = new LinkedHashMap<>();
  private final int keep;

  public HttpColumn(Spec spec, int total) {
    this.spec = spec;
    this.total = total;
    this.batches = spec.batch() <= 0 ? 0 : (total + spec.batch() - 1) / spec.batch();
    // The batch being read, the one before it (a reader may look one row back across the seam)
    // and everything already on the wire.
    this.keep = spec.parallel() + 2;
  }

  /** The answer for one absolute row. */
  public String valueAt(int row, IntFunction<String> inputAt) {
    int size = spec.batch();
    int k = row / size;
    List<Integer> ahead = new ArrayList<>();
    for (int j = k + 1; j < Math.min(k + spec.parallel(), batches); j++) {
      ahead.add(j);
    }
    List<String> values = batch(k, k + 1, ahead, inputAt);
    int at = row - k * size;
    return at < values.size() ? values.get(at) : "";
  }

  /**
   * The answers for these absolute rows, in the order given. Only the batches holding them are
   * requested, in ascending order, each exactly once.
   */
  public List<String> valuesAt(int[] rows, IntFunction<String> inputAt) {
    int size = spec.batch();
    TreeSet<Integer> set = new TreeSet<>();
    for (int row : rows) {
      set.add(row / size);
    }
    List<Integer> needed = new ArrayList<>(set);
    Map<Integer, List<String>> byBatch = new HashMap<>();
    for (int i = 0; i < needed.size(); i++) {
      int k = needed.get(i);
      Integer next = i + 1 < needed.size() ? needed.get(i + 1) : null;
      int end = Math.min(i + spec.parallel(), needed.size());
      List<Integer> ahead = needed.subList(Math.min(i + 1, end), end);
      byBatch.put(k, batch(k, next, ahead, inputAt));
    }
    List<String> out = new ArrayList<>(rows.length);
    for (int row : rows) {
      int k = row / size;
      List<String> values = byBatch.getOrDefault(k, List.of());
      int at = row - k * size;
      out.add(at < values.size() ? values.get(at) : "");
    }
    return out;
  }

  private List<String> batch(
      int k, Integer next, List<Integer> ahead, IntFunction<String> inputAt) {
    List<String> done = answered.get(k);
    if (done != null) {
      return done;
    }
    // The batch being read always goes out — the limit governs what is sent AHEAD, not what the
    // reader is waiting for.
    send(k, true, inputAt);
    for (int j : ahead) {
      send(j, false, inputAt);
    }
    InFlight flight = inFlight.remove(k);
    if (flight == null) {
      return List.of();
    }
    List<String> values = answer(flight);
    remember(k, values);
    if (next != null && next < batches) {
      send(next, false, inputAt);
    }
    return values;
  }

  private void send(int k, boolean needed, IntFunction<String> inputAt) {
    if (k < 0 || k >= batches || inFlight.containsKey(k) || answered.containsKey(k)) {
      return;
    }
    // Never more than `parallel` out at once: a service that is not safe to call concurrently
    // gets exactly one request at a time under the default.
    if (!needed && inFlight.size() >= spec.parallel()) {
      return;
    }
    int offset = k * spec.batch();
    int count = Math.min(spec.batch(), total - offset);
    List<String> inputs = null;
    if (spec.inName() != null) {
      inputs = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        inputs.add(inputAt.apply(offset + i));
      }
    }
    List<String> body = inputs;
    CompletableFuture<List<String>> future =
        CompletableFuture.supplyAsync(
            () ->
                HttpGen.fetch(
                    spec.src(),
                    count,
                    offset,
                    total,
                    body,
                    spec.seed(),
                    spec.onError(),
                    spec.timeoutMs(),
                    spec.secret()),
            POOL);
    inFlight.put(k, new InFlight(future, offset, count));
  }

  /** Wait for a batch, naming its rows in a failure when the column has several. */
  private List<String> answer(InFlight flight) {
    try {
      return flight.future().join();
    } catch (CompletionException e) {
      if (e.getCause() instanceof HttpGen.ServiceException failed) {
        String where =
            batches > 1
                ? " (rows " + flight.offset() + "–" + (flight.offset() + flight.count() - 1) + ")"
                : "";
        throw new ColumnException(
            "http service for sequence \""
                + spec.sequence()
                + "\" at "
                + failed.url
                + where
                + " "
                + failed.getMessage(),
            failed);
      }
      if (e.getCause() instanceof RuntimeException runtime) {
        throw runtime;
      }
      throw e;
    }
  }

  private void remember(int k, List<String> values) {
    answered.put(k, values);
    while (answered.size() > keep) {
      Integer oldest = answered.keySet().iterator().next();
      answered.remove(oldest);
    }
  }

  /** A positive whole number from {@code batch=}/{@code parallel=}, or the default. */
  static int parseCount(String raw, int fallback) {
    if (raw == null) {
      return fallback;
    }
    String text = raw.trim();
    if (text.isEmpty() || !text.chars().allMatch(c -> c >= '0' && c <= '9')) {
      return fallback;
    }
    try {
      int n = Integer.parseInt(text);
      return n > 0 ? n : fallback;
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  /**
   * The http columns of one run, one per generator and column, made on first use and kept — so
   * a reader building one row at a time reads the batches the previous row fetched instead of
   * asking again.
   *
   * <p>Held per thread while a run builds ({@link #open}), because the generators are static and
   * the run that owns them is the one on this thread.
   */
  public static final class Session implements AutoCloseable {
    private static final ThreadLocal<Session> CURRENT = new ThreadLocal<>();

    private final String envSeed;
    private final Path baseDir;
    private final int total;
    /** By generator IDENTITY: two generators written alike are still two columns. */
    private final Map<Object, Map<String, HttpColumn>> columns = new java.util.IdentityHashMap<>();
    private final Session previous;
    private final java.util.function.BiFunction<String, Integer, String> reader;

    private Session(
        String envSeed,
        Path baseDir,
        int total,
        java.util.function.BiFunction<String, Integer, String> reader,
        Session previous) {
      this.envSeed = envSeed;
      this.baseDir = baseDir;
      this.total = total;
      this.reader = reader;
      this.previous = previous;
    }

    /**
     * Open the session for a run on this thread. {@code reader} reads a finished column at an
     * absolute row — what an {@code in=} column is sent up from.
     */
    public static Session open(
        String envSeed,
        Path baseDir,
        int total,
        java.util.function.BiFunction<String, Integer, String> reader) {
      Session made = new Session(envSeed, baseDir, total, reader, CURRENT.get());
      CURRENT.set(made);
      return made;
    }

    /** The session of the run building on this thread, or null. */
    public static Session current() {
      return CURRENT.get();
    }

    /** Rows in the run — what every http column of it is long. */
    public int total() {
      return total;
    }

    /** The run's own reader of finished columns. */
    public String read(String name, int row) {
      String value = reader.apply(name, row);
      return value == null ? "" : value;
    }

    @Override
    public void close() {
      if (previous == null) {
        CURRENT.remove();
      } else {
        CURRENT.set(previous);
      }
    }

    /** The column for this generator, as {@code sequence} reads it. */
    public HttpColumn column(Object gen, Map<String, String> attrs, String sequence, int total) {
      Map<String, HttpColumn> bySequence =
          columns.computeIfAbsent(gen, key -> new HashMap<>());
      HttpColumn known = bySequence.get(sequence);
      if (known != null) {
        return known;
      }
      // Resolved per column and never cached: two sequences may sign with two different secrets,
      // and a config naming an unset variable should say so in terms of the sequence the reader
      // wrote.
      String secretSpec = attrs.get("secret");
      String secret = null;
      if (secretSpec != null && !secretSpec.trim().isEmpty()) {
        try {
          secret = HttpGen.resolveSecret(secretSpec, baseDir);
        } catch (HttpGen.SecretException e) {
          throw new ColumnException(
              "http service for sequence \"" + sequence + "\": " + e.getMessage(), e);
        }
      }
      String in = attrs.get("in");
      Spec spec =
          new Spec(
              sequence,
              attrs.getOrDefault("src", ""),
              in == null || in.trim().isEmpty() ? null : in.trim(),
              HttpGen.seedFor(envSeed, sequence),
              secret,
              HttpGen.onError(attrs),
              HttpGen.timeoutMs(attrs.get("timeout")),
              parseCount(attrs.get("batch"), DEFAULT_BATCH),
              parseCount(attrs.get("parallel"), 1));
      HttpColumn made = new HttpColumn(spec, total);
      bySequence.put(sequence, made);
      return made;
    }
  }
}
