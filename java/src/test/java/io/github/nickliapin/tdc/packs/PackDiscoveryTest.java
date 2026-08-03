package io.github.nickliapin.tdc.packs;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Which folder the packs come out of, before any config or command line adds to it.
 *
 * <p>One rule in all five implementations: {@code TDCV2_PACKS}, then the source checkout this build
 * came from, then the starter set inside the artefact. What is worth testing here is the middle
 * one — it is the step that used to differ between implementations, and the step that can capture
 * the wrong folder if the marker is dropped.
 *
 * <p>This class sits in the {@code packs} package rather than beside the other pack tests because
 * the method it exercises is package-private: the rule is worth pinning, the entry point is not
 * worth publishing.
 */
class PackDiscoveryTest {

  @Test
  @DisplayName("finds the repository this build came from")
  void findsThisRepository() {
    Path found = DataPacks.sourceCheckoutPacks(Path.of("").toAbsolutePath());
    assertNotNull(found, "the tests run inside a checkout, so the walk must find one");
    assertEquals("packs", found.getFileName().toString());
    assertEquals("data", found.getParent().getFileName().toString());
  }

  @Test
  @DisplayName("refuses a data/packs that is not this repository")
  void refusesAStranger(@TempDir Path root) throws IOException {
    // The point of the marker. Without it an unrelated `data/packs` above an installed jar would
    // answer, and the same config would then read different data depending on where the user
    // happened to install it.
    Files.createDirectories(root.resolve("data").resolve("packs").resolve("en"));
    Path deep = root.resolve("project").resolve("deep");
    Files.createDirectories(deep);

    assertNull(DataPacks.sourceCheckoutPacks(deep));
  }

  @Test
  @DisplayName("accepts a checkout from any depth below it")
  void acceptsACheckout(@TempDir Path root) throws IOException {
    Files.createDirectories(root.resolve("data").resolve("packs"));
    Files.createDirectories(root.resolve("fixtures").resolve("cross-language"));
    Path deep = root.resolve("a").resolve("b").resolve("c");
    Files.createDirectories(deep);

    assertEquals(root.resolve("data").resolve("packs"), DataPacks.sourceCheckoutPacks(deep));
  }
}
