package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.packs.ProjectConfig;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A project's own packs, found the way the CLI writes them down.
 *
 * <p>The alternative is a library that resolves a downloaded pack in the language that fetched it
 * and nowhere else — a config that is not portable for a reason nothing in the config explains.
 */
class ProjectPacksTest {

  @Test
  @DisplayName("a project's config adds its pack folder, and its packs shadow the bundled ones")
  void projectPacksShadowBundled(@TempDir Path project) throws IOException {
    Path packs = project.resolve("tdcv2-packs");
    Files.createDirectories(packs.resolve("en").resolve("person"));
    Files.writeString(packs.resolve("en/person/lastName.txt"), "Sobolev\nKuznetsov\n");
    Files.writeString(
        project.resolve(ProjectConfig.PROJECT_CONFIG_NAME), "{\"dataPaths\": [\"tdcv2-packs\"]}");

    DataPacks resolved = DataPacks.forProject(project);
    assertEquals(java.util.List.of("Sobolev", "Kuznetsov"), resolved.load("person.lastName", "en").values());

    // Everything else still comes from the jar — a project pack adds to the set, it does not
    // replace it.
    assertTrue(resolved.exists("person.male.firstName", "en"));
  }

  @Test
  @DisplayName("the config is found from a subdirectory, the way a compiler finds its own")
  void searchesUpward(@TempDir Path project) throws IOException {
    Files.writeString(project.resolve(ProjectConfig.PROJECT_CONFIG_NAME), "{\"locale\": \"ru\"}");
    Path nested = project.resolve("a").resolve("b");
    Files.createDirectories(nested);

    ProjectConfig.Resolved resolved = ProjectConfig.load(nested);
    assertEquals("ru", resolved.locale());
    assertEquals(1, resolved.sources().size());
  }

  @Test
  @DisplayName("a broken config is refused, not quietly skipped")
  void refusesABrokenConfig(@TempDir Path project) throws IOException {
    Files.writeString(project.resolve(ProjectConfig.PROJECT_CONFIG_NAME), "{\"dataPaths\": \"nope\"}");
    RuntimeException e =
        assertThrows(RuntimeException.class, () -> ProjectConfig.load(project));
    assertTrue(e.getMessage().contains("dataPaths"), "unhelpful message: " + e.getMessage());

    Files.writeString(project.resolve(ProjectConfig.PROJECT_CONFIG_NAME), "{not json}");
    RuntimeException malformed =
        assertThrows(RuntimeException.class, () -> ProjectConfig.load(project));
    assertTrue(malformed.getMessage().contains("JSON"), "unhelpful: " + malformed.getMessage());
  }
}
