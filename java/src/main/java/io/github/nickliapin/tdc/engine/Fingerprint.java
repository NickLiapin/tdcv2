package io.github.nickliapin.tdc.engine;

import io.github.nickliapin.tdc.prng.Prng;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * Tuple fingerprints — how a large uniq run finds its duplicates.
 *
 * <p>Sorting the tuples THEMSELVES means sorting text: records of eighty-odd characters, millions
 * of strings, each one an object the collector has to track. That text is what makes the middle of
 * a big run heavy — in scratch disk, in sort time, and in memory.
 *
 * <p>None of it is needed to DETECT a duplicate. Detection only asks "are these two the same?",
 * and a hash answers that in thirteen bytes:
 *
 * <pre>
 *     [hi 4B][lo 4B][row index 5B]   big-endian, fixed width
 * </pre>
 *
 * <p>Fixed width and big-endian together buy the whole design. Comparing the raw thirteen bytes IS
 * comparing {@code (hi, lo, index)}, so sorting needs no comparator and every implementation
 * agrees by construction. And a record's place in a file is {@code 13 * ordinal}, so a sorted pile
 * can be binary-searched on disk: "is this tuple taken?" costs about twenty-five tiny reads and no
 * resident memory at all.
 *
 * <p>A 64-bit hash is not proof — two different tuples can collide — so a group of records sharing
 * a hash is a CANDIDATE, not a verdict. Candidates are verified by recomputing the actual tuples
 * by row number, which the engine can do for any row at any time. That is what makes the
 * duplicates found exactly the ones the text sort would name.
 *
 * <p>Every number here is part of the cross-language contract, pinned by {@code
 * fixtures/cross-language/fingerprint-vectors.json}.
 */
public final class Fingerprint {

  /** Bytes per record: 4 (hash hi) + 4 (hash lo) + 5 (row index). */
  public static final int RECORD_BYTES = 13;

  /** Rows a 5-byte index can name. Checked at the door rather than wrapped silently. */
  public static final long MAX_INDEX = 1L << 40;

  /** Records held in memory per sort batch. */
  private static final int SORT_BATCH = 2_000_000;

  private Fingerprint() {}

  /** The 64-bit fingerprint of a tuple key, as two 32-bit halves in a long array. */
  public static int[] hash64(String key) {
    int[] state = Prng.cyrb128(key);
    return new int[] {state[0], state[1]};
  }

  /** Which pile a fingerprint belongs to. Unsigned remainder — the hash word is unsigned. */
  public static int bucketOf(int hi, int buckets) {
    return (int) (Integer.toUnsignedLong(hi) % buckets);
  }

  /**
   * How many piles for a run of {@code count} rows.
   *
   * <p>A short run gets one pile — the signal to stay on the exact text path, where hashing has
   * nothing to pay for itself with. Above that, four piles per core: measured sizes come out even
   * enough that no core waits on a straggler.
   */
  public static int bucketCountFor(long count, int cores) {
    if (count < 1_000_000L) {
      return 1;
    }
    return Math.min(256, Math.max(2, Math.max(1, cores) * 4));
  }

  /** One record's bytes. Refuses an index the five bytes cannot carry rather than wrapping it. */
  public static byte[] encode(int hi, int lo, long index) {
    if (index >= MAX_INDEX) {
      throw new IllegalArgumentException(
          "fingerprint index " + index + " exceeds the 5-byte record limit (" + MAX_INDEX
              + " rows)");
    }
    byte[] out = new byte[RECORD_BYTES];
    ByteBuffer.wrap(out).putInt(0, hi).putInt(4, lo);
    for (int b = 0; b < 5; b++) {
      out[8 + b] = (byte) ((index >>> ((4 - b) * 8)) & 0xFF);
    }
    return out;
  }

  /** The row index carried by one record. */
  public static long indexOf(byte[] record, int at) {
    long index = 0;
    for (int b = 0; b < 5; b++) {
      index = (index << 8) | (record[at + 8 + b] & 0xFFL);
    }
    return index;
  }

  /** Writes fingerprint records to a file, buffered. */
  public static final class Writer implements AutoCloseable {
    private final OutputStream out;

    public Writer(Path path) {
      try {
        out = new BufferedOutputStream(Files.newOutputStream(path), 1 << 20);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    public void write(int hi, int lo, long index) {
      try {
        out.write(encode(hi, lo, index));
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    @Override
    public void close() {
      try {
        out.close();
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }
  }

  /**
   * Hash rows {@code [from, to)} and route each fingerprint into its pile file.
   *
   * <p>Returns one path per pile, in pile order. Nothing is sorted here — a pile is sorted by
   * whoever picks it up.
   */
  public static List<Path> writePiles(
      List<java.util.function.IntFunction<String>> resolvers,
      int from,
      int to,
      Path dir,
      String prefix,
      int buckets,
      String join) {
    List<Path> paths = new ArrayList<>();
    List<Writer> writers = new ArrayList<>();
    for (int b = 0; b < buckets; b++) {
      Path path = dir.resolve(prefix + "-" + b);
      paths.add(path);
      writers.add(new Writer(path));
    }
    try {
      StringBuilder key = new StringBuilder();
      for (int row = from; row < to; row++) {
        key.setLength(0);
        for (int r = 0; r < resolvers.size(); r++) {
          if (r > 0) {
            key.append(join);
          }
          key.append(resolvers.get(r).apply(row));
        }
        int[] h = hash64(key.toString());
        writers.get(bucketOf(h[0], buckets)).write(h[0], h[1], row);
      }
    } finally {
      for (Writer writer : writers) {
        writer.close();
      }
    }
    return paths;
  }

  /**
   * Sort any number of fingerprint files into ONE sorted file. Returns the record count.
   *
   * <p>The records are sorted AS BYTES. Because the encoding is big-endian and fixed width, that
   * is exactly {@code (hi, lo, index)} ascending — no comparator to reproduce, and no way for two
   * implementations to disagree about the order.
   */
  public static long sortFiles(List<Path> inputs, Path outPath, Path tmpRoot) {
    Path dir;
    try {
      dir = Files.createTempDirectory(tmpRoot, "tdc-fp-sort-");
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    List<Path> runs = new ArrayList<>();
    long total = 0;
    try {
      List<byte[]> batch = new ArrayList<>();
      for (Path input : inputs) {
        try (var in = Files.newInputStream(input)) {
          byte[] buffer = new byte[RECORD_BYTES * 4096];
          int read;
          while ((read = in.readNBytes(buffer, 0, buffer.length)) > 0) {
            for (int at = 0; at + RECORD_BYTES <= read; at += RECORD_BYTES) {
              batch.add(Arrays.copyOfRange(buffer, at, at + RECORD_BYTES));
              total++;
              if (batch.size() >= SORT_BATCH) {
                runs.add(writeRun(batch, dir, runs.size()));
              }
            }
          }
        } catch (IOException e) {
          throw new UncheckedIOException(e);
        }
      }
      if (!batch.isEmpty()) {
        runs.add(writeRun(batch, dir, runs.size()));
      }
      mergeRuns(runs, outPath);
      return total;
    } finally {
      for (Path run : runs) {
        try {
          Files.deleteIfExists(run);
        } catch (IOException ignored) {
          // A leftover run in a temp directory is not worth failing a run over.
        }
      }
      try {
        Files.deleteIfExists(dir);
      } catch (IOException ignored) {
        // Same.
      }
    }
  }

  private static Path writeRun(List<byte[]> batch, Path dir, int index) {
    batch.sort(Arrays::compareUnsigned);
    Path path = dir.resolve("run-" + index);
    try (var out = new BufferedOutputStream(Files.newOutputStream(path), 1 << 20)) {
      for (byte[] record : batch) {
        out.write(record);
      }
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    batch.clear();
    return path;
  }

  private static void mergeRuns(List<Path> runs, Path outPath) {
    List<java.io.InputStream> streams = new ArrayList<>();
    try (var out = new BufferedOutputStream(Files.newOutputStream(outPath), 1 << 20)) {
      byte[][] heads = new byte[runs.size()][];
      for (Path run : runs) {
        streams.add(Files.newInputStream(run));
      }
      for (int r = 0; r < runs.size(); r++) {
        heads[r] = readRecord(streams.get(r));
      }
      while (true) {
        int best = -1;
        for (int r = 0; r < heads.length; r++) {
          if (heads[r] == null) {
            continue;
          }
          if (best < 0 || Arrays.compareUnsigned(heads[r], heads[best]) < 0) {
            best = r;
          }
        }
        if (best < 0) {
          break;
        }
        out.write(heads[best]);
        heads[best] = readRecord(streams.get(best));
      }
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    } finally {
      for (var stream : streams) {
        try {
          stream.close();
        } catch (IOException ignored) {
          // Nothing left to do about a stream that will not close.
        }
      }
    }
  }

  private static byte[] readRecord(java.io.InputStream in) throws IOException {
    byte[] record = new byte[RECORD_BYTES];
    int read = in.readNBytes(record, 0, RECORD_BYTES);
    return read == RECORD_BYTES ? record : null;
  }

  /**
   * Row groups that share a fingerprint, from a SORTED file.
   *
   * <p>Candidates, not verdicts: a 64-bit collision between different tuples lands here too, so
   * the caller recomputes the true tuples and keeps only the rows that genuinely repeat.
   */
  public static List<List<Long>> candidateGroups(Path sortedPath) {
    List<List<Long>> out = new ArrayList<>();
    try (var in = Files.newInputStream(sortedPath)) {
      byte[] current = null;
      List<Long> group = new ArrayList<>();
      byte[] record;
      while ((record = readRecord(in)) != null) {
        if (current == null || Arrays.compareUnsigned(record, 0, 8, current, 0, 8) != 0) {
          if (group.size() >= 2) {
            out.add(group);
          }
          group = new ArrayList<>();
          current = record;
        }
        group.add(indexOf(record, 0));
      }
      if (group.size() >= 2) {
        out.add(group);
      }
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
    return out;
  }

  /**
   * "Is this tuple already taken?" — answered by binary search on the sorted piles.
   *
   * <p>The sorted fingerprints ARE the ledger; a lookup is about twenty-five record-sized reads
   * and no resident memory. Rows being reassigned have their old tuples freed, so a match counts
   * only if some matching record's row is not among them. A 64-bit collision can only make the
   * answer "taken" for a free tuple — the repair then picks another combination; it can never hide
   * a taken one.
   */
  public static final class Ledger implements ExactUniq.Membership, AutoCloseable {
    private final List<RandomAccessFile> files = new ArrayList<>();
    private final long[] counts;
    private final Set<Integer> moving;
    private final int piles;
    private final byte[] probe = new byte[RECORD_BYTES];

    public Ledger(List<Path> sortedPaths, Set<Integer> moving) {
      this.moving = moving;
      this.piles = sortedPaths.size();
      this.counts = new long[piles];
      try {
        for (int b = 0; b < piles; b++) {
          files.add(new RandomAccessFile(sortedPaths.get(b).toFile(), "r"));
          counts[b] = Files.size(sortedPaths.get(b)) / RECORD_BYTES;
        }
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    @Override
    public boolean has(String key) {
      int[] h = hash64(key);
      int pile = bucketOf(h[0], piles);
      long count = counts[pile];
      if (count == 0) {
        return false;
      }
      byte[] wanted = encode(h[0], h[1], 0);
      RandomAccessFile file = files.get(pile);
      try {
        long low = 0;
        long high = count;
        while (low < high) {
          long mid = (low + high) >>> 1;
          file.seek(mid * RECORD_BYTES);
          file.readFully(probe);
          if (Arrays.compareUnsigned(probe, 0, 8, wanted, 0, 8) < 0) {
            low = mid + 1;
          } else {
            high = mid;
          }
        }
        for (long at = low; at < count; at++) {
          file.seek(at * RECORD_BYTES);
          file.readFully(probe);
          if (Arrays.compareUnsigned(probe, 0, 8, wanted, 0, 8) != 0) {
            break;
          }
          if (!moving.contains((int) indexOf(probe, 0))) {
            return true;
          }
        }
        return false;
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }

    @Override
    public void close() {
      for (RandomAccessFile file : files) {
        try {
          file.close();
        } catch (IOException ignored) {
          // Nothing left to do about a file that will not close.
        }
      }
    }
  }

  /** Sorting a batch needs a total order over records; exposed for the tests. */
  public static Comparator<byte[]> byteOrder() {
    return Arrays::compareUnsigned;
  }
}
