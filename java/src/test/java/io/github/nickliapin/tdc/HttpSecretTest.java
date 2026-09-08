package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.generators.HttpGen;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Where {@code secret=} may live, and what is refused wherever it came from.
 *
 * <p>Not a rendering fixture, and it could not be one: two of the three spellings read something
 * OUTSIDE the config — an environment variable and a file on disk — which is the whole reason
 * they exist. A shared case can only say what a config renders to.
 *
 * <p>What each check is worth: an empty secret signs with nothing, and a signature every caller
 * could forge is worse than not signing at all. A file read WITHOUT the trailing newline that
 * every editor adds agrees with no other implementation. And a failure that returns a blank
 * instead of stopping would sign the run with an empty key and send it.
 */
class HttpSecretTest {

  @Test
  @DisplayName("a literal is taken as it stands, minus the whitespace around it")
  void literal() {
    assertEquals("plain-value", HttpGen.resolveSecret("  plain-value  ", Path.of(".")));
  }

  @Test
  @DisplayName("an empty secret is refused, whichever of the three spellings it arrived in")
  void emptyIsRefusedEverywhere(@TempDir Path dir) throws IOException {
    Path blank = dir.resolve("blank.key");
    Files.writeString(blank, "\n   \n");
    assertThrows(HttpGen.SecretException.class, () -> HttpGen.resolveSecret("", dir));
    assertThrows(HttpGen.SecretException.class, () -> HttpGen.resolveSecret("   ", dir));
    assertThrows(HttpGen.SecretException.class, () -> HttpGen.resolveSecret("env:", dir));
    assertThrows(HttpGen.SecretException.class, () -> HttpGen.resolveSecret("file:", dir));
    assertThrows(
        HttpGen.SecretException.class, () -> HttpGen.resolveSecret("file:blank.key", dir));
  }

  @Test
  @DisplayName("env: reads the variable, and says so when it is not set")
  void fromTheEnvironment() {
    // PATH is set in every environment this suite can run in, which is what makes it usable as
    // the success case: a test cannot set a variable in its own process.
    String path = System.getenv("PATH");
    if (path != null && !path.isBlank()) {
      assertEquals(path.trim(), HttpGen.resolveSecret("env:PATH", Path.of(".")));
      assertEquals(path.trim(), HttpGen.resolveSecret("  env: PATH  ", Path.of(".")));
    }
    HttpGen.SecretException missing =
        assertThrows(
            HttpGen.SecretException.class,
            () -> HttpGen.resolveSecret("env:TDC_DEFINITELY_UNSET_SECRET", Path.of(".")));
    assertTrue(
        missing.getMessage().contains("TDC_DEFINITELY_UNSET_SECRET"),
        "the message has to name the variable the reader must go and set: "
            + missing.getMessage());
  }

  @Test
  @DisplayName("file: reads the file, relative to the config, and drops the trailing newline")
  void fromAFile(@TempDir Path dir) throws IOException {
    Files.writeString(dir.resolve("api.key"), "s3cr3t-key\n");
    assertEquals("s3cr3t-key", HttpGen.resolveSecret("file:api.key", dir));
    assertEquals(
        "s3cr3t-key", HttpGen.resolveSecret("file:" + dir.resolve("api.key"), Path.of(".")));

    Path nested = dir.resolve("keys");
    Files.createDirectories(nested);
    Files.writeString(nested.resolve("api.key"), "  nested-key  ");
    assertEquals("nested-key", HttpGen.resolveSecret("file:keys/api.key", dir));
  }

  @Test
  @DisplayName("a file that is not there stops the run and names the path that was tried")
  void missingFile(@TempDir Path dir) {
    HttpGen.SecretException e =
        assertThrows(
            HttpGen.SecretException.class, () -> HttpGen.resolveSecret("file:absent.key", dir));
    assertTrue(
        e.getMessage().contains("absent.key"),
        "the message has to name the file: " + e.getMessage());
  }

  @Test
  @DisplayName("a ~ path is expanded against the home directory, not read as a folder named ~")
  void tildeIsExpanded() {
    String home = System.getProperty("user.home", "");
    if (home.isEmpty()) {
      return;
    }
    // Nothing is written under the real home directory; the read is expected to FAIL. What the
    // failure proves is WHERE it looked — the message carries the resolved path, so a "~" that
    // was never expanded, or one resolved against the config's folder, both show up here.
    HttpGen.SecretException e =
        assertThrows(
            HttpGen.SecretException.class,
            () ->
                HttpGen.resolveSecret(
                    "file:~/tdcv2-no-such-secret-file.key", Path.of("/nonexistent-base")));
    assertTrue(
        e.getMessage().contains(home + "/tdcv2-no-such-secret-file.key"),
        "~ must resolve against the home directory: " + e.getMessage());
    assertTrue(
        !e.getMessage().contains("/nonexistent-base"),
        "an absolute ~ path is never joined to the config's folder: " + e.getMessage());
  }
}
