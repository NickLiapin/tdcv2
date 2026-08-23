package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.engine.Fingerprint;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The fingerprint layer against the shared cross-language vectors.
 *
 * <p>Every number in that fixture decides WHICH tuples a large uniq run avoids, so an
 * implementation that differs in any of them produces a different file from the same seed. Hash,
 * pile, record bytes and pile count are each pinned here rather than trusted.
 */
class FingerprintVectorsTest {

  private static JsonNode vectors() {
    try {
      return new ObjectMapper()
          .readTree(
              Files.readString(
                  Path.of("..", "fixtures", "cross-language", "fingerprint-vectors.json")
                      .toAbsolutePath()
                      .normalize()));
    } catch (IOException e) {
      throw new IllegalStateException("cannot read fingerprint-vectors.json", e);
    }
  }

  @Test
  @DisplayName("record width and index limit match the contract")
  void widthAndLimit() {
    assertEquals(vectors().get("recordBytes").asInt(), Fingerprint.RECORD_BYTES);
    assertEquals(vectors().get("maxIndex").asLong(), Fingerprint.MAX_INDEX);
  }

  @Test
  @DisplayName("hash and pile match the reference for every key")
  void hashesAndPiles() {
    for (JsonNode vector : vectors().get("hashes")) {
      String key = vector.get("key").asText();
      int[] h = Fingerprint.hash64(key);
      assertEquals(vector.get("hi").asLong(), Integer.toUnsignedLong(h[0]), "hi of " + key);
      assertEquals(vector.get("lo").asLong(), Integer.toUnsignedLong(h[1]), "lo of " + key);
      vector
          .get("buckets")
          .fields()
          .forEachRemaining(
              entry ->
                  assertEquals(
                      entry.getValue().asInt(),
                      Fingerprint.bucketOf(h[0], Integer.parseInt(entry.getKey())),
                      "pile of " + key + " over " + entry.getKey()));
    }
  }

  @Test
  @DisplayName("record bytes match the reference, and read back as written")
  void recordBytes() {
    for (JsonNode vector : vectors().get("records")) {
      int hi = (int) vector.get("hi").asLong();
      int lo = (int) vector.get("lo").asLong();
      long index = vector.get("index").asLong();
      byte[] encoded = Fingerprint.encode(hi, lo, index);

      StringBuilder hex = new StringBuilder();
      for (byte b : encoded) {
        hex.append(String.format("%02x", b));
      }
      assertEquals(vector.get("bytes").asText(), hex.toString(), "bytes for index " + index);
      // A reader that disagrees with its own writer is worse than one that disagrees with the
      // reference, because nothing would catch it.
      assertEquals(index, Fingerprint.indexOf(encoded, 0));
    }
  }

  @Test
  @DisplayName("an index past the limit is refused, not wrapped")
  void indexOverflowRefused() {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class, () -> Fingerprint.encode(1, 1, Fingerprint.MAX_INDEX));
    assertTrue(e.getMessage().contains("5-byte"), e.getMessage());
  }

  @Test
  @DisplayName("pile count matches the reference")
  void pileCounts() {
    for (JsonNode vector : vectors().get("pileCounts")) {
      assertEquals(
          vector.get("buckets").asInt(),
          Fingerprint.bucketCountFor(vector.get("count").asLong(), vector.get("cores").asInt()),
          vector.get("count").asText() + " rows / " + vector.get("cores").asText() + " cores");
    }
  }

  @Test
  @DisplayName("sorting is byte order, and every repeated fingerprint is found")
  void sortingAndCandidates(@TempDir Path dir) throws IOException {
    List<Path> inputs = new ArrayList<>();
    List<Fingerprint.Writer> writers = new ArrayList<>();
    for (int k = 0; k < 3; k++) {
      Path path = dir.resolve("in-" + k);
      inputs.add(path);
      writers.add(new Fingerprint.Writer(path));
    }

    for (int i = 0; i < 300; i++) {
      int[] h = Fingerprint.hash64("unique-" + i);
      writers.get(i % 3).write(h[0], h[1], i);
    }
    int[] dupA = Fingerprint.hash64("dupA");
    for (long row : new long[] {7, 105, 203}) {
      writers.get(0).write(dupA[0], dupA[1], row);
    }
    int[] dupB = Fingerprint.hash64("dupB");
    for (long row : new long[] {50, 151}) {
      writers.get(1).write(dupB[0], dupB[1], row);
    }
    // Same high word, differing low words, written descending: an order that only comes out right
    // if the low word decides. 305 random hashes never collide in 32 bits, so without these the
    // sort could ignore the low word and still pass.
    for (int lo = 9; lo >= 0; lo--) {
      writers.get(0).write(777, lo, 400 + lo);
    }
    for (Fingerprint.Writer writer : writers) {
      writer.close();
    }

    Path sorted = dir.resolve("sorted");
    assertEquals(315, Fingerprint.sortFiles(inputs, sorted, dir));

    byte[] all = Files.readAllBytes(sorted);
    assertEquals(315 * Fingerprint.RECORD_BYTES, all.length);
    for (int at = Fingerprint.RECORD_BYTES; at < all.length; at += Fingerprint.RECORD_BYTES) {
      byte[] prev = java.util.Arrays.copyOfRange(all, at - Fingerprint.RECORD_BYTES, at);
      byte[] here = java.util.Arrays.copyOfRange(all, at, at + Fingerprint.RECORD_BYTES);
      assertTrue(java.util.Arrays.compareUnsigned(prev, here) <= 0, "not in byte order at " + at);
    }

    List<List<Long>> groups = Fingerprint.candidateGroups(sorted);
    assertEquals(2, groups.size());
    for (List<Long> group : groups) {
      java.util.Collections.sort(group);
    }
    assertTrue(groups.contains(List.of(7L, 105L, 203L)), groups.toString());
    assertTrue(groups.contains(List.of(50L, 151L)), groups.toString());
  }

  @Test
  @DisplayName("the ledger never calls a taken tuple free")
  void ledger(@TempDir Path dir) {
    int buckets = 4;
    List<String> keys = new ArrayList<>();
    for (int i = 0; i < 500; i++) {
      keys.add("taken-" + i);
    }

    List<Fingerprint.Writer> raw = new ArrayList<>();
    for (int b = 0; b < buckets; b++) {
      raw.add(new Fingerprint.Writer(dir.resolve("raw-" + b)));
    }
    for (int row = 0; row < keys.size(); row++) {
      int[] h = Fingerprint.hash64(keys.get(row));
      raw.get(Fingerprint.bucketOf(h[0], buckets)).write(h[0], h[1], row);
    }
    for (Fingerprint.Writer writer : raw) {
      writer.close();
    }

    List<Path> sortedPaths = new ArrayList<>();
    for (int b = 0; b < buckets; b++) {
      Path out = dir.resolve("sorted-" + b);
      Fingerprint.sortFiles(List.of(dir.resolve("raw-" + b)), out, dir);
      sortedPaths.add(out);
    }

    Set<Integer> moving = new HashSet<>(List.of(3, 4));
    try (Fingerprint.Ledger ledger = new Fingerprint.Ledger(sortedPaths, moving)) {
      // The property uniqueness rests on: every taken tuple answers taken.
      for (int row = 0; row < keys.size(); row++) {
        if (!moving.contains(row)) {
          assertTrue(ledger.has(keys.get(row)), keys.get(row));
        }
      }
      // A tuple held ONLY by rows being moved is free — those values are being given away.
      assertFalse(ledger.has("taken-3"));
      assertFalse(ledger.has("taken-4"));
      // And tuples nobody holds are free.
      for (int i = 0; i < 200; i++) {
        assertFalse(ledger.has("nobody-" + i));
      }
    }
  }

  @Test
  @DisplayName("the same key always lands in the same pile")
  void routingIsPure() {
    for (String key : List.of("MaleIvanPetrov", "a", "ключ с юникодом", "")) {
      for (int buckets : new int[] {2, 7, 44, 256}) {
        int first = Fingerprint.bucketOf(Fingerprint.hash64(key)[0], buckets);
        int again = Fingerprint.bucketOf(Fingerprint.hash64(new String(key))[0], buckets);
        assertEquals(first, again, key);
        assertTrue(first >= 0 && first < buckets, "pile out of range for " + key);
      }
    }
    assertArrayEquals(Fingerprint.hash64("a"), Fingerprint.hash64("a"));
  }
}
