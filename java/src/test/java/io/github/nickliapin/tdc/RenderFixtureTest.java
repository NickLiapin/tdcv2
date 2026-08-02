package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.nickliapin.tdc.engine.MemoryEngine;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.parser.ConfigBuilder;
import io.github.nickliapin.tdc.parser.TdcParserFacade;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * End to end against the captured baselines: parse, generate, render, compare bytes.
 *
 * <p>The fixture list comes from the manifest every implementation reads, not from a list typed
 * here. A hard-coded list drifts silently — a fixture added for the TypeScript engine would
 * never run against this one, and the port would look finished while missing a feature.
 *
 * <p>Byte equality is the only assertion worth making. Data that is merely plausible proves
 * nothing: the promise is that one config and one seed produce the same bytes in every language,
 * and only a comparison of the bytes tests that.
 */
class RenderFixtureTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path fixtures() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir);
  }

  private static Path packs() {
    String dir = System.getProperty("tdc.packs");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.packs is not set");
    return Path.of(dir);
  }

  private static Path manifest() {
    return fixtures().resolve("cross-language/manifest.json");
  }

  private static Stream<Arguments> manifestFixtures() throws IOException {
    JsonNode doc = JSON.readTree(Files.readString(manifest()));
    Path base = manifest().getParent();
    // The clock comes from the manifest, never from the machine: a date generator reading the
    // real time would pass today and fail tomorrow from the very same seed.
    long fixedNow = Instant.parse(doc.get("fixedNow").asText()).toEpochMilli();

    List<Arguments> out = new ArrayList<>();
    for (JsonNode entry : doc.get("runtimeFixtures")) {
      // Manifest paths are relative to the manifest's own folder.
      out.add(
          Arguments.of(
              entry.get("name").asText(),
              base.resolve(entry.get("source").asText()).normalize(),
              base.resolve(entry.get("expected").asText()).normalize(),
              fixedNow));
    }
    return out.stream();
  }

  private static String render(Path source, long nowMillis) throws IOException {
    TdcParserFacade.Result parsed = TdcParserFacade.parse(Files.readString(source));
    assertTrue(parsed.ok(), source + " did not parse: " + parsed.problems());
    Config config = ConfigBuilder.build(parsed.tree());
    return MemoryEngine.render(config, new DataPacks(packs()), nowMillis);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("manifestFixtures")
  @DisplayName("renders byte-identical to the captured baseline")
  void matchesBaseline(String name, Path source, Path expectedFile, long nowMillis)
      throws IOException {
    String expected = Files.readString(expectedFile);
    String actual = render(source, nowMillis);

    if (!expected.equals(actual)) {
      // A whole-file diff of a hundred lines is unreadable in a failure report; the first
      // differing line is what a person actually needs to see.
      List<String> want = Arrays.asList(expected.split("\n", -1));
      List<String> got = Arrays.asList(actual.split("\n", -1));
      for (int i = 0; i < Math.max(want.size(), got.size()); i++) {
        String w = i < want.size() ? want.get(i) : "<missing>";
        String g = i < got.size() ? got.get(i) : "<missing>";
        if (!w.equals(g)) {
          assertEquals(w, g, name + ": first difference at line " + (i + 1));
        }
      }
    }
    assertEquals(expected, actual, name);
  }

  @Test
  @DisplayName("the split is exact and children stay inside their parent's rows")
  void invariantsHold() throws IOException {
    String[] rows = render(fixtures().resolve("tdc_sequence_demo.xml"), 0).split("\n");
    assertEquals("ID,Gender,ProstateIssue,BreastIssue", rows[0], "header");

    int male = 0;
    int female = 0;
    for (int i = 1; i <= 100; i++) {
      String[] cells = rows[i].split(",", -1);
      String gender = cells[1];
      if ("Male".equals(gender)) {
        male++;
        assertEquals("", cells[3], "row " + i + ": a male row carries a BreastIssue");
      } else {
        female++;
        assertEquals("", cells[2], "row " + i + ": a female row carries a ProstateIssue");
      }
    }
    // 42/58 of 100, exactly — the reason percent exists.
    assertEquals(42, male);
    assertEquals(58, female);
  }
}
