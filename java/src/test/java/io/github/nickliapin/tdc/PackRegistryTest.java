package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.packs.PackRegistry;
import io.github.nickliapin.tdc.packs.ProjectConfig;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Fetching data packs from the registry every implementation shares.
 *
 * <p>Against a real server rather than a stubbed client: the thing being checked is the wire —
 * the index's shape, the digest, what happens when the bytes are wrong. A fake that returns
 * whatever the test wants would prove only that the test agrees with itself.
 */
class PackRegistryTest {

  private HttpServer server;
  private String baseUrl;
  private byte[] bundleZip;
  private String bundleSha;

  @BeforeEach
  void startRegistry() throws Exception {
    // The zip carries the bundle id at its root, which is the registry's layout: unpacking into
    // the store lands it at <store>/xx/packs.
    bundleZip = zip("xx/packs/xx/person/firstName.txt", "Ilmatar\nVäinö\n");
    bundleSha = sha256(bundleZip);

    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();

    String index =
        """
        {
          "schemaVersion": 1,
          "description": "test registry",
          "bundles": [
            {
              "id": "xx",
              "name": "Example (language)",
              "description": "a made-up locale",
              "file": "bundles/xx.zip",
              "bytes": %d,
              "sha256": "%s",
              "locale": "xx",
              "contents": ["person"]
            }
          ]
        }"""
            .formatted(bundleZip.length, bundleSha);

    serve("/index.json", index.getBytes(StandardCharsets.UTF_8));
    serve("/bundles/xx.zip", bundleZip);
    // The same bundle with one byte flipped, for the case that matters most.
    byte[] corrupt = bundleZip.clone();
    corrupt[corrupt.length / 2] ^= 0x40;
    serve("/bundles/corrupt.zip", corrupt);
    server.start();
  }

  @AfterEach
  void stopRegistry() {
    server.stop(0);
  }

  @Test
  @DisplayName("a bundle downloads, verifies and resolves as packs")
  void installsABundle(@TempDir Path project) throws IOException {
    PackRegistry registry = new PackRegistry(baseUrl);
    PackRegistry.Index index = registry.index();
    assertEquals(1, index.bundles().size());
    assertEquals("xx", index.bundles().get(0).id());
    assertEquals("xx", index.bundles().get(0).locale());

    Path store = project.resolve("tdcv2-packs");
    Path root = registry.install(index.find("xx"), store);
    assertTrue(Files.isRegularFile(root.resolve("xx/person/firstName.txt")));
    assertEquals(List.of("xx"), PackRegistry.installed(store));

    // Registered the way the config cascade expects, the downloaded pack resolves like any other.
    Files.writeString(
        project.resolve(ProjectConfig.PROJECT_CONFIG_NAME),
        "{\"dataPaths\": [\"tdcv2-packs/xx/packs\"]}");
    DataPacks packs = DataPacks.forProject(project);
    assertEquals(List.of("Ilmatar", "Väinö"), packs.load("person.firstName", "xx").values());
    // And the starter set that ships in the jar is still there underneath it.
    assertTrue(packs.exists("person.male.firstName", "en"));
  }

  @Test
  @DisplayName("one call installs a bundle and writes it into the project's config")
  void installsThroughTheFacade(@TempDir Path project) throws IOException {
    // No config yet: the common case, a project adding its first locale.
    DataPacks packs = DataPacks.install(project, new PackRegistry(baseUrl), "xx");

    assertEquals(List.of("Ilmatar", "Väinö"), packs.load("person.firstName", "xx").values());
    String config = Files.readString(project.resolve(ProjectConfig.PROJECT_CONFIG_NAME));
    assertTrue(config.contains("tdcv2-packs/xx/packs"), "config should name the pack root: " + config);

    // A second run is not a second entry, and the first locale still resolves.
    DataPacks again = DataPacks.install(project, new PackRegistry(baseUrl), "xx");
    assertEquals(
        1,
        Files.readString(project.resolve(ProjectConfig.PROJECT_CONFIG_NAME))
            .split("tdcv2-packs/xx/packs", -1).length - 1,
        "installing twice should not duplicate the entry");
    assertTrue(again.exists("person.firstName", "xx"));
  }

  @Test
  @DisplayName("bytes that do not match the published digest are refused, not unpacked")
  void refusesACorruptDownload(@TempDir Path store) {
    PackRegistry registry = new PackRegistry(baseUrl);
    PackRegistry.Bundle real = registry.index().find("xx");
    // Same digest, different file: what a tampered or truncated download looks like.
    PackRegistry.Bundle swapped =
        new PackRegistry.Bundle(
            "corrupt", real.name(), real.description(), "bundles/corrupt.zip",
            real.bytes(), real.sha256(), real.locale(), real.country(), real.contents(),
            real.regions(), real.point());

    RuntimeException e =
        assertThrows(RuntimeException.class, () -> registry.install(swapped, store));
    assertTrue(e.getMessage().contains("checksum"), "unhelpful message: " + e.getMessage());
    assertTrue(
        PackRegistry.installed(store).isEmpty(),
        "nothing should be written when the bytes are wrong");
  }

  @Test
  @DisplayName("an unknown bundle names what there is instead of failing blankly")
  void namesWhatIsAvailable() {
    RuntimeException e =
        assertThrows(RuntimeException.class, () -> new PackRegistry(baseUrl).index().find("nope"));
    assertTrue(e.getMessage().contains("Available: xx"), e.getMessage());
  }

  @Test
  @DisplayName("a malformed index is refused with the reason")
  void refusesAMalformedIndex() {
    RuntimeException e =
        assertThrows(
            RuntimeException.class, () -> PackRegistry.parseIndex("{\"schemaVersion\": 99}"));
    assertTrue(e.getMessage().contains("schemaVersion"), e.getMessage());
  }

  private void serve(String path, byte[] body) {
    server.createContext(
        path,
        exchange -> {
          exchange.sendResponseHeaders(200, body.length);
          try (java.io.OutputStream out = exchange.getResponseBody()) {
            out.write(body);
          }
        });
  }

  private static byte[] zip(String name, String body) throws IOException {
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    try (ZipOutputStream zip = new ZipOutputStream(bytes)) {
      zip.putNextEntry(new ZipEntry(name));
      zip.write(body.getBytes(StandardCharsets.UTF_8));
      zip.closeEntry();
    }
    return bytes.toByteArray();
  }

  private static String sha256(byte[] data) throws Exception {
    StringBuilder out = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(data)) {
      out.append(String.format("%02x", b));
    }
    return out.toString();
  }
}
