package io.github.nickliapin.tdc.cli;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * The pack picker's map, against the shared fixture.
 *
 * <p>The picker is about 5,600 lines across the five implementations and had no test at all — the
 * largest untested surface in the project. Most of it is a terminal loop, and a loop that reads
 * keys is not something a fixture can hold. Its geometry is, and geometry is the part five copies
 * of a coordinate table can quietly disagree about: each implementation keeps its own continent
 * outlines, so one hand-edited number would move a coastline in one language and nowhere else.
 *
 * <p>The tables were identical when this was written — measured, all six continents, every
 * number. The point PROJECTION was not: Python's {@code round} breaks a tie to the even number
 * and Rust and C# break it away from zero, and 58 (country, map size) pairs among the 198 that
 * ship land on exactly a tie.
 */
class PackPickerMapTest {

  private static JsonNode fixture() {
    try {
      return new ObjectMapper()
          .readTree(
              Files.readString(Path.of("..", "fixtures", "cross-language", "pack-picker.json")));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static final JsonNode DATA = fixture();

  @Test
  @DisplayName("fits the map to the terminal")
  void fitsTheMapToTheTerminal() {
    for (JsonNode c : DATA.get("mapSizes")) {
      int[] got =
          PackPicker.mapSize(
              c.get("columns").asInt(),
              c.get("rows").asInt(),
              c.get("reserved").asInt(),
              c.get("halfBlocks").asBoolean());
      JsonNode want = c.get("size");
      String where =
          c.get("columns").asInt() + "x" + c.get("rows").asInt() + " half " + c.get("halfBlocks");
      if (want == null || want.isNull()) {
        assertNull(got, where);
      } else {
        assertArrayEquals(new int[] {want.get("w").asInt(), want.get("h").asInt()}, got, where);
      }
    }
  }

  @Test
  @DisplayName("rasterises the continents to the same pixels")
  void rasterisesTheContinents() {
    for (JsonNode c : DATA.get("rasters")) {
      List<String> want = new ArrayList<>();
      for (JsonNode row : c.get("rows")) {
        want.add(row.asText());
      }
      assertEquals(
          want,
          PackPicker.mapRows(c.get("w").asInt(), c.get("h").asInt()),
          "raster " + c.get("w").asInt() + "x" + c.get("h").asInt());
    }
  }

  @Test
  @DisplayName("puts a country where the country is")
  void putsACountryWhereTheCountryIs() {
    for (JsonNode c : DATA.get("points")) {
      int[] got =
          PackPicker.mapCell(
              c.get("lon").asDouble(),
              c.get("lat").asDouble(),
              c.get("w").asInt(),
              c.get("h").asInt());
      JsonNode want = c.get("cell");
      String where =
          c.get("name").asText() + " on " + c.get("w").asInt() + "x" + c.get("h").asInt();
      if (want == null || want.isNull()) {
        assertNull(got, where);
      } else {
        assertArrayEquals(new int[] {want.get("col").asInt(), want.get("row").asInt()}, got, where);
      }
    }
  }

  @Test
  @DisplayName("the frame is half-open, so its far corner is just past the map")
  void theFrameIsHalfOpen() {
    assertArrayEquals(new int[] {0, 0}, PackPicker.mapCell(-170, 84, 56, 22));
    assertNull(PackPicker.mapCell(190, -56, 56, 22));
    assertArrayEquals(new int[] {55, 21}, PackPicker.mapCell(189, -55, 56, 22));
    assertNull(PackPicker.mapCell(0, 90, 56, 22));
    assertNull(PackPicker.mapCell(0, -90, 56, 22));
  }

  @Test
  @DisplayName("half-blocks buy height, so the same terminal takes a bigger map")
  void halfBlocksBuyHeight() {
    int[] half = PackPicker.mapSize(120, 40, 13, true);
    int[] full = PackPicker.mapSize(120, 40, 13, false);
    assertNotNull(half);
    assertNotNull(full);
    assertTrue(half[0] > full[0], half[0] + " against " + full[0]);
  }

  @Test
  @DisplayName("refuses to draw rather than squash")
  void refusesToDraw() {
    assertNull(PackPicker.mapSize(59, 200, 0, true), "narrower than the smallest map");
    assertNull(PackPicker.mapSize(200, 14, 13, true), "no room for the list beside it");
  }
}
