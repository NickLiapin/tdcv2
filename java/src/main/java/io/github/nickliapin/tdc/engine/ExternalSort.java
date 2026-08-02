package io.github.nickliapin.tdc.engine;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.PriorityQueue;

/**
 * Sort more records than fit in memory.
 *
 * <p>The oldest trick there is, and still the right one: fill a buffer, sort it, write it out,
 * repeat; then merge the sorted runs by always taking the smallest head. Memory is bounded by one
 * chunk plus one line per run, whatever the input's size.
 *
 * <p>Engine 3 needs it for one question — are any two records identical — which cannot be
 * answered by a hash set once the answer stops fitting in RAM. Sorting puts equal records next to
 * each other, and the scan that follows holds nothing but the group it is in.
 *
 * <p>An input that fits in a single chunk never touches the disk. Most runs are that, and paying
 * for temp files to sort ten thousand rows would make the exact engine slower than the one it
 * exists to replace.
 */
final class ExternalSort {

  /** Records held in memory per run. Roughly a hundred megabytes of short keys. */
  private static final int DEFAULT_CHUNK = 1_000_000;

  private ExternalSort() {}

  /**
   * The records in ascending order.
   *
   * <p>Returns an iterator rather than a list on purpose: the caller scans it once, and
   * materializing the result would give back exactly the memory this class was called to save.
   * Byte order, not locale order — the keys are opaque and only equality of neighbours matters.
   */
  static Iterator<String> sort(Iterator<String> records, int chunkSize, Path tmpDir) {
    int chunkLimit = Math.max(1, chunkSize <= 0 ? DEFAULT_CHUNK : chunkSize);
    List<Path> runs = new ArrayList<>();
    List<String> chunk = new ArrayList<>();
    Path dir = null;

    try {
      while (records.hasNext()) {
        chunk.add(records.next());
        if (chunk.size() >= chunkLimit) {
          if (dir == null) {
            dir = Files.createTempDirectory(tmpDir, "tdc-esort-");
          }
          runs.add(writeRun(chunk, dir, runs.size()));
          chunk = new ArrayList<>();
        }
      }

      // It all fit. Sort in memory and never create a file — the common case by far.
      if (runs.isEmpty()) {
        Collections.sort(chunk);
        return chunk.iterator();
      }
      if (!chunk.isEmpty()) {
        runs.add(writeRun(chunk, dir, runs.size()));
      }
      return new Merge(runs, dir);
    } catch (IOException e) {
      throw new UncheckedIOException("cannot sort on disk", e);
    }
  }

  private static Path writeRun(List<String> chunk, Path dir, int index) throws IOException {
    Collections.sort(chunk);
    Path path = dir.resolve("run-" + index + ".txt");
    try (BufferedWriter out =
        Files.newBufferedWriter(path, StandardCharsets.UTF_8)) {
      for (String record : chunk) {
        out.write(record);
        out.write('\n');
      }
    }
    return path;
  }

  /** The k-way merge: one line per run in memory, and the temp files gone when it ends. */
  private static final class Merge implements Iterator<String> {

    private record Head(String value, int run) {}

    private final List<BufferedReader> readers = new ArrayList<>();
    private final PriorityQueue<Head> heap =
        new PriorityQueue<>(Comparator.comparing(Head::value).thenComparingInt(Head::run));
    private final Path dir;
    private boolean closed;

    Merge(List<Path> runs, Path dir) throws IOException {
      this.dir = dir;
      for (int run = 0; run < runs.size(); run++) {
        BufferedReader reader = Files.newBufferedReader(runs.get(run), StandardCharsets.UTF_8);
        readers.add(reader);
        String line = reader.readLine();
        if (line != null) {
          heap.add(new Head(line, run));
        }
      }
      if (heap.isEmpty()) {
        cleanUp();
      }
    }

    @Override
    public boolean hasNext() {
      return !heap.isEmpty();
    }

    @Override
    public String next() {
      Head top = heap.poll();
      if (top == null) {
        throw new NoSuchElementException();
      }
      try {
        String line = readers.get(top.run()).readLine();
        if (line != null) {
          heap.add(new Head(line, top.run()));
        } else if (heap.isEmpty()) {
          // The last run is drained: close the handles and drop the directory now rather than
          // waiting for a caller to remember to.
          cleanUp();
        }
      } catch (IOException e) {
        cleanUp();
        throw new UncheckedIOException("cannot read a sorted run", e);
      }
      return top.value();
    }

    private void cleanUp() {
      if (closed) {
        return;
      }
      closed = true;
      for (BufferedReader reader : readers) {
        try {
          reader.close();
        } catch (IOException ignored) {
          // Closing a file we are done reading; nothing useful to do about a failure here.
        }
      }
      if (dir != null) {
        try (java.util.stream.Stream<Path> entries = Files.walk(dir)) {
          entries.sorted(Comparator.reverseOrder()).forEach(ExternalSort::deleteQuietly);
        } catch (IOException ignored) {
          // Temp files in the system's own temp directory; the OS clears them eventually.
        }
      }
    }
  }

  private static void deleteQuietly(Path path) {
    try {
      Files.deleteIfExists(path);
    } catch (IOException ignored) {
      // As above — a leftover temp file is not worth failing a finished run over.
    }
  }
}
