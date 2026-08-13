package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The Parquet writer, held to the reference's bytes.
 *
 * <p>Not "a reader can open it" — the same length and the same digest. Two Parquet writers can
 * both be correct and disagree byte for byte, because the format leaves compression and encoding
 * choices to whoever writes. This project promises the files match, and a digest is the only
 * thing that checks it.
 */
class CrossLanguageParquetTest {

  private static final ObjectMapper JSON = new ObjectMapper();

  private static Path fixture() {
    String dir = System.getProperty("tdc.fixtures");
    assertTrue(dir != null && !dir.isBlank(), "system property tdc.fixtures is not set");
    return Path.of(dir).resolve("cross-language/parquet.json");
  }

  private static Stream<Arguments> cases() throws IOException {
    JsonNode document = JSON.readTree(Files.readString(fixture()));
    long now = Instant.parse(document.get("now").asText()).toEpochMilli();
    List<Arguments> out = new ArrayList<>();
    for (JsonNode node : document.get("cases")) {
      out.add(Arguments.of(node.get("name").asText(), node, now));
    }
    assertTrue(!out.isEmpty(), "no Parquet cases found in " + fixture());
    return out.stream();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("cases")
  @DisplayName("writes the same bytes as the reference")
  void matchesTheReference(String name, JsonNode node, long now) throws Exception {
    TDC.Options options = TDC.options().configString(node.get("config").asText()).now(now);
    // A case with `dataPath` reads sample files from a folder under `cases/`, the same field
    // and the same place the shared cases already use.
    if (node.hasNonNull("dataPath")) {
      options.baseDir(fixture().getParent().resolve("cases").resolve(node.get("dataPath").asText()));
    }
    TDC tdc = options.build();
    byte[] bytes =
        io.github.nickliapin.tdc.output.ParquetOutput.toBytes(tdc.config(), tdc.rows());

    assertEquals(
        node.get("size").asInt(),
        bytes.length,
        name + " (" + node.get("description").asText() + "): file size differs");
    assertEquals(node.get("sha256").asText(), sha256(bytes), name + ": file contents differ");
  }

  private static String sha256(byte[] bytes) throws Exception {
    StringBuilder out = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) {
      out.append(String.format("%02x", b));
    }
    return out.toString();
  }
}
