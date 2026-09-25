package io.github.nickliapin.tdc.generators;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * How many different strings a regex pattern makes, against the shared fixture.
 *
 * <p>{@code uniq="true"} over a {@code type="regex"} pattern refuses a count the pattern cannot
 * meet before it draws, and knows the pattern's size by counting its parse tree. That count
 * decides which configs are refused, so all five implementations are held to one set of numbers —
 * including the deliberate overcounts, which are the contract rather than a mistake.
 */
class RegexSpaceTest {

  private static JsonNode fixture() throws IOException {
    return new ObjectMapper()
        .readTree(Files.readString(Path.of("..", "fixtures", "cross-language", "regex-space.json")));
  }

  @Test
  @DisplayName("saturates at the same ceiling as the reference")
  void saturatesAtTheSameCeiling() throws IOException {
    assertEquals(fixture().get("cap").asLong(), RegexGen.SPACE_CAP);
  }

  @Test
  @DisplayName("counts every pattern's space the way the reference counts it")
  void countsTheSpaceTheReferenceCounts() throws IOException {
    for (JsonNode c : fixture().get("patterns")) {
      assertEquals(
          c.get("size").asLong(),
          RegexGen.spaceSize(c.get("pattern").asText(), RegexGen.DEFAULT_MAX_LENGTH),
          c.get("pattern").asText() + " — " + c.get("why").asText());
    }
  }

  @Test
  @DisplayName("counts every advanced pattern's space the way the reference counts it")
  void countsAnAdvancedPatternTheWayTheReferenceDoes() throws IOException {
    for (JsonNode c : fixture().get("advanced")) {
      assertEquals(
          c.get("size").asLong(),
          AdvancedRegexGen.spaceSize(c.get("pattern").asText(), RegexGen.DEFAULT_MAX_LENGTH),
          c.get("pattern").asText() + " — " + c.get("why").asText());
    }
  }
}
