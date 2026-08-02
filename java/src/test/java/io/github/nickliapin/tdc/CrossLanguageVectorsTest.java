package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.prng.Prng;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The cross-language contract.
 *
 * <p>These vectors are the same files the TypeScript and Python implementations are checked
 * against. They are not a Java test of Java code — they are the definition of what "the same
 * output in every language" means, and this port either reproduces them exactly or it does not
 * belong in the repository.
 *
 * <p>Failing here is never a reason to edit the vectors.
 */
class CrossLanguageVectorsTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path fixtures() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir, "cross-language");
  }

  private static JsonNode read(String name) throws IOException {
    Path file = fixtures().resolve(name);
    assertTrue(Files.exists(file), "missing vector file: " + file);
    return JSON.readTree(Files.readString(file));
  }

  // ------------------------------------------------------------------ PRNG

  @Test
  @DisplayName("cyrb128 + sfc32 reproduce every seed in prng-vectors.json")
  void prngVectors() throws IOException {
    JsonNode doc = read("prng-vectors.json");
    assertEquals("cyrb128+sfc32", doc.get("algorithm").asText());

    int checked = 0;
    for (JsonNode vector : doc.get("vectors")) {
      String seed = vector.get("seed").asText();
      Prng.Sfc32 prng = Prng.create(seed);
      JsonNode expected = vector.get("values");
      for (int i = 0; i < expected.size(); i++) {
        double actual = prng.next();
        // Exact equality is the point. These are doubles produced by identical integer
        // arithmetic, so "close enough" would hide precisely the drift this test exists
        // to catch.
        assertEquals(
            expected.get(i).asDouble(),
            actual,
            0.0,
            () -> "seed \"" + seed + "\" diverges from the reference implementation");
        checked++;
      }
    }
    assertTrue(checked > 0, "the vector file produced nothing to check");
  }

  @Test
  @DisplayName("a draw stays in [0, 1) over a long run")
  void prngRange() {
    Prng.Sfc32 prng = Prng.create("range-probe");
    for (int i = 0; i < 100_000; i++) {
      double v = prng.next();
      assertTrue(v >= 0.0 && v < 1.0, "draw out of range: " + v);
    }
  }

  @Test
  @DisplayName("the same seed replays the same sequence")
  void prngIsReproducible() {
    List<Double> first = draws("replay", 50);
    List<Double> second = draws("replay", 50);
    assertEquals(first, second);
  }

  private static List<Double> draws(String seed, int n) {
    Prng.Sfc32 prng = Prng.create(seed);
    List<Double> out = new ArrayList<>(n);
    for (int i = 0; i < n; i++) {
      out.add(prng.next());
    }
    return out;
  }

  // -------------------------------------------------------------- Hamilton

  private static Stream<Arguments> hamiltonVectors() throws IOException {
    List<Arguments> cases = new ArrayList<>();
    for (JsonNode vector : read("hamilton-vectors.json").get("vectors")) {
      cases.add(Arguments.of(vector.get("name").asText(), vector));
    }
    return cases.stream();
  }

  @ParameterizedTest(name = "{0}")
  @DisplayName("Hamilton reproduces the shared vectors")
  @MethodSource("hamiltonVectors")
  void hamiltonVector(String name, JsonNode vector) {
    int count = vector.get("count").asInt();
    List<String> values = new ArrayList<>();
    vector.get("values").forEach(v -> values.add(v.asText()));
    double[] percents = new double[vector.get("percents").size()];
    for (int i = 0; i < percents.length; i++) {
      percents[i] = vector.get("percents").get(i).asDouble();
    }

    Prng.Sfc32 prng = Prng.create(vector.get("seed").asText());
    List<String> produced = Hamilton.distribute(count, values, percents, prng);

    assertEquals(count, produced.size(), name + ": wrong number of rows");

    // Some vectors pin the whole sequence, others a prefix plus the totals. Both matter:
    // the totals prove the apportionment, the order proves the shuffle consumed the
    // generator in the same order.
    if (vector.has("expected")) {
      List<String> expected = new ArrayList<>();
      vector.get("expected").forEach(v -> expected.add(v.asText()));
      assertEquals(expected, produced, name + ": sequence differs from the reference");
    }
    if (vector.has("expectedPrefix")) {
      JsonNode prefix = vector.get("expectedPrefix");
      for (int i = 0; i < prefix.size(); i++) {
        assertEquals(
            prefix.get(i).asText(), produced.get(i), name + ": row " + i + " differs");
      }
    }
    if (vector.has("expectedCounts")) {
      vector
          .get("expectedCounts")
          .fields()
          .forEachRemaining(
              e -> {
                long actual = produced.stream().filter(v -> v.equals(e.getKey())).count();
                assertEquals(
                    e.getValue().asLong(), actual, name + ": count for " + e.getKey());
              });
    }
  }

  @Test
  @DisplayName("percentages that do not divide the count still sum to it")
  void hamiltonAlwaysFillsTheCount() {
    for (int count : new int[] {1, 2, 3, 7, 99, 1000}) {
      Prng.Sfc32 prng = Prng.create("sum-" + count);
      int[] counts = Hamilton.countsPerValue(count, new double[] {33.33, 33.33, 33.34}, prng);
      int total = 0;
      for (int c : counts) {
        total += c;
      }
      assertEquals(count, total, "counts do not add up to " + count);
    }
  }
}
