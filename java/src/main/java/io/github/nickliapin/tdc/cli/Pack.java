package io.github.nickliapin.tdc.cli;

import io.github.nickliapin.tdc.packs.PackRegistry;
import io.github.nickliapin.tdc.packs.PackStore;
import io.github.nickliapin.tdc.packs.ProjectConfig;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;

/**
 * {@code tdcv2 pack} — the data packs, from the shared registry.
 *
 * <p>The library ships with English and the USA and nothing else, because the packs are meant to
 * grow to a size no library should carry. Everything else is downloaded on demand from one registry
 * that all three implementations read, so a pack fetched by any of them works in the other two.
 *
 * <p>A bundle is axis-pure — one language ({@code en}), or one country ({@code usa}), or {@code
 * common} — because language and country are independent and compose: US English is common + en +
 * usa. Everything lands in ONE tree, at its address path: {@code <store>/ru/…}, {@code
 * <store>/countries/usa/…}. Which bundle owns which path is written down in {@code
 * <store>/.tdcv2-installed.json} rather than implied by a folder name, so ten languages and a
 * hundred countries are one folder and one {@code dataPaths} entry.
 *
 * <p>Where things go is decided by the config cascade, not guessed: {@code packStore} from the
 * nearest {@code tdcv2.config.json}, else the global one. With neither, {@code init} has not been
 * run and this says so rather than inventing a folder.
 */
public final class Pack {

  private Pack() {}

  private static final String USAGE =
      """
      Usage: tdcv2 pack [command]

        list                  Show what can be installed, and what already is
        add <id>...           Download and install one or more bundles
        remove <id>...        Uninstall, and drop them from the config

        --registry <url>      Use another registry (default: the public one)
      """;

  /** Where downloads go, and which config file records them. */
  public record Store(Path path, Path configPath) {}

  /**
   * The pack folder and the config that owns it, from the cascade.
   *
   * <p>A project config wins over the global one — packs belong to the project that uses them.
   * Neither means {@code init} has not run, and guessing a folder here would put data somewhere
   * the next command would not look.
   */
  public static Store resolveStore(Path cwd) {
    ProjectConfig.Resolved resolved = ProjectConfig.load(cwd);

    Path configPath = ProjectConfig.findProjectConfig(cwd);
    if (configPath == null) {
      configPath = ProjectConfig.globalConfigPath();
    }
    if (configPath == null || !Files.isRegularFile(configPath)) {
      throw new PackRegistry.PackException("no tdcv2.config.json found — run `tdcv2 init` first");
    }
    if (resolved.packStore() == null) {
      throw new PackRegistry.PackException(
          "config \""
              + configPath
              + "\" does not name a \"packStore\" — add one, or re-run `tdcv2 init --force`");
    }
    return new Store(resolved.packStore(), configPath);
  }

  public static int run(List<String> argv, Path cwd) {
    if (argv.contains("-h") || argv.contains("--help")) {
      System.out.print(USAGE);
      return 0;
    }

    String registryUrl = null;
    List<String> rest = new ArrayList<>();
    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);
      if (arg.equals("--registry")) {
        i++;
        if (i >= argv.size()) {
          System.err.println("tdcv2: missing value for --registry");
          return 2;
        }
        registryUrl = argv.get(i);
      } else if (arg.startsWith("--registry=")) {
        registryUrl = arg.substring("--registry=".length());
      } else {
        rest.add(arg);
      }
    }

    String command = rest.isEmpty() ? "list" : rest.get(0);
    List<String> ids = rest.isEmpty() ? List.of() : rest.subList(1, rest.size());

    Store store;
    try {
      store = resolveStore(cwd);
    } catch (PackRegistry.PackException e) {
      System.err.println("tdcv2: " + e.getMessage());
      return 2;
    }

    PackRegistry registry =
        registryUrl == null ? new PackRegistry() : new PackRegistry(registryUrl);

    try {
      // Before anything reads the store: a store from an older tdcv2 is in the old per-bundle
      // layout, which `list`, `add` and `remove` all now misread. The first `tdcv2 pack` after an
      // upgrade fixes it, once, and says what it did.
      PackStore.Migration migration = PackStore.migrate(store.path(), store.configPath());
      if (migration != null) {
        reportMigration(migration);
      }

      // No subcommand and a terminal that can host the picker: browse the catalogue instead of
      // printing it. Anywhere else — a pipe, a script, CI, Windows — printing is the right answer.
      if (rest.isEmpty() && PackPicker.available()) {
        return browse(registry, store);
      }
      switch (command) {
        case "list":
          return list(registry, store);
        case "add":
          if (ids.isEmpty()) {
            System.err.println("tdcv2: `pack add` needs at least one bundle id");
            return 2;
          }
          return add(registry, store, ids);
        case "remove":
          if (ids.isEmpty()) {
            System.err.println("tdcv2: `pack remove` needs at least one bundle id");
            return 2;
          }
          return remove(store, ids);
        default:
          System.err.println(
              "tdcv2: unknown pack command \"" + command + "\" (use list | add | remove)");
          return 2;
      }
    } catch (PackRegistry.PackException | UncheckedIOException e) {
      System.err.println("tdcv2: " + e.getMessage());
      return 2;
    }
  }

  /**
   * The catalogue, browsed rather than listed.
   *
   * <p>The picker only decides; installing and removing stay here, so the digests, the progress
   * reporting and the config writing have one home whether the ids were typed or pointed at.
   */
  private static int browse(PackRegistry registry, Store store) {
    PackRegistry.Index index = registry.index();
    if (index.bundles().isEmpty()) {
      System.out.println("No bundles in the registry.");
      return 0;
    }

    PackPicker.Decision decision =
        PackPicker.run(index.bundles(), new HashSet<>(PackRegistry.installed(store.path())));
    if (decision == null) {
      return 0;
    }
    if (!decision.remove().isEmpty()) {
      remove(store, decision.remove());
    }
    if (!decision.install().isEmpty()) {
      return add(registry, store, decision.install());
    }
    if (decision.remove().isEmpty()) {
      System.out.println("Nothing selected.");
    }
    return 0;
  }

  /** Where a description starts: two spaces, the id column, a space. */
  /**
   * The narrowest the id column ever gets: two spaces, twelve, a space.
   *
   * <p>It grows to fit the widest id in the catalogue — {@code sao_tome_and_principe} is
   * twenty-one characters, and a fixed twelve pushed every column after it out of line on that row
   * alone. It never shrinks below this, so a short catalogue keeps the shape the shared CLI fixture
   * pins.
   */
  private static final int MIN_ID_WIDTH = 12;

  /**
   * Text folded to the terminal, with every line under the same indent.
   *
   * <p>Descriptions run to two hundred characters. Printed as one line each they wrap wherever
   * the window happens to end and the remainder lands hard against the left margin, which turns a
   * list of a hundred packs into a wall nobody can read down. Off a terminal there is no width to
   * ask for, so 80 is assumed — the same answer every implementation gives, which keeps their
   * output identical when it is piped.
   */
  private static List<String> wrap(String text, int indent) {
    int width = Math.max(40, terminalColumns()) - indent;
    String pad = " ".repeat(indent);
    List<String> lines = new ArrayList<>();
    StringBuilder line = new StringBuilder();
    for (String word : text.trim().split("\\s+")) {
      if (word.isEmpty()) {
        continue;
      }
      if (line.length() == 0) {
        line.append(word);
      } else if (line.length() + 1 + word.length() <= width) {
        line.append(' ').append(word);
      } else {
        lines.add(pad + line);
        line = new StringBuilder(word);
      }
    }
    if (line.length() > 0) {
      lines.add(pad + line);
    }
    return lines;
  }

  /**
   * How wide the terminal is, or 80 when there is not one.
   *
   * <p>Asked of the terminal itself, never of {@code COLUMNS}: the other two implementations ask
   * the file descriptor, and an environment variable that only one of them honours is a way for
   * the same command to print differently in the same shell.
   */
  private static int terminalColumns() {
    try {
      Process process =
          new ProcessBuilder("stty", "size")
              .redirectInput(ProcessBuilder.Redirect.INHERIT)
              .start();
      String out =
          new String(
              process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
      process.waitFor();
      String[] parts = out.trim().split("\\s+");
      if (parts.length == 2) {
        return Integer.parseInt(parts[1]);
      }
    } catch (IOException | NumberFormatException e) {
      return 80;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
    return 80;
  }

  private static int list(PackRegistry registry, Store store) {
    PackRegistry.Index index = registry.index();
    Set<String> here = new HashSet<>(PackRegistry.installed(store.path()));

    if (index.bundles().isEmpty()) {
      System.out.println("No bundles in the registry.");
      return 0;
    }

    int idWidth = MIN_ID_WIDTH;
    for (PackRegistry.Bundle bundle : index.bundles()) {
      idWidth = Math.max(idWidth, bundle.id().length());
    }
    // Two spaces of margin, the id column, one space — where a description and the "installed"
    // mark both start.
    int indent = 2 + idWidth + 1;

    System.out.println("Available data packs:");
    System.out.println();
    for (PackRegistry.Bundle bundle : index.bundles()) {
      String mark = here.contains(bundle.id()) ? "\u2713 installed" : " ";
      System.out.printf(
          Locale.ROOT,
          "  %-" + idWidth + "s %-12s %s (%s)%n",
          bundle.id(),
          mark,
          bundle.name(),
          megabytes(bundle.bytes()));
      for (String line : wrap(bundle.description(), indent)) {
        System.out.println(line);
      }
      System.out.println();
    }

    // An id in the store that the registry no longer lists still works; saying so beats a silent
    // omission that reads like the pack is gone.
    Set<String> known = new HashSet<>();
    for (PackRegistry.Bundle bundle : index.bundles()) {
      known.add(bundle.id());
    }
    Set<String> orphans = new TreeSet<>(Comparator.naturalOrder());
    for (String id : here) {
      if (!known.contains(id)) {
        orphans.add(id);
      }
    }
    if (!orphans.isEmpty()) {
      System.out.println("Installed but not in this registry: " + String.join(", ", orphans));
      System.out.println();
    }

    System.out.println("Install with: tdcv2 pack add <id>");
    return 0;
  }

  private static int add(PackRegistry registry, Store store, List<String> ids) {
    PackRegistry.Index index = registry.index();
    // Every id is looked up before anything is downloaded, so a typo in the third one does not
    // leave the first two half-installed.
    List<PackRegistry.Bundle> bundles = new ArrayList<>();
    for (String id : ids) {
      bundles.add(index.find(id));
    }

    for (PackRegistry.Bundle bundle : bundles) {
      System.err.println(
          "tdcv2: downloading " + bundle.id() + " (" + megabytes(bundle.bytes()) + ")…");
      PackStore.InstalledBundle entry = registry.install(bundle, store.path());
      // The STORE goes into the config, once, however many bundles land in it \u2014 never the bundle,
      // which no longer has a folder of its own to name.
      String stored = ProjectConfig.storedPath(store.configPath(), store.path());
      boolean added = ProjectConfig.register(store.configPath(), List.of(store.path()));
      System.out.println(
          "Installed " + bundle.id() + ": " + entry.files() + " files \u2192 "
              + installedAt(store.path(), entry.paths()));
      System.out.println(
          added
              ? "  registered " + stored + " in " + store.configPath()
              : "  already registered in " + store.configPath());
    }
    return 0;
  }

  /** Where a bundle's data ended up, for the line that reports an install. */
  private static String installedAt(Path store, List<String> paths) {
    List<String> absolute = new ArrayList<>();
    for (String path : paths) {
      absolute.add(PackStore.resolve(store, path).toString());
    }
    return String.join(", ", absolute);
  }

  /**
   * Uninstall bundles: delete exactly the paths the store recorded for each, and drop the store
   * from the config once nothing is left in it. No network.
   *
   * <p>Deleting by record rather than by folder name is what a shared tree costs and what it buys:
   * {@code russia} lives at {@code countries/russia} beside {@code countries/usa}, and only the
   * recorded path goes. Because installs SHADOW the bundled default rather than replacing it,
   * removing a bundle simply lets the default resurface — no hole.
   */
  private static int remove(Store store, List<String> ids) {
    PackStore.InstalledRecord record = PackStore.read(store.path());
    for (String id : ids) {
      PackStore.InstalledBundle entry = PackStore.find(record, id);
      if (entry == null) {
        // Not an error. `remove` is asked for to reach a state, and that state already holds;
        // exiting non-zero would make an idempotent script fail on its second run.
        System.err.println("tdcv2: \"" + id + "\" is not installed — nothing to remove");
        continue;
      }
      PackStore.deleteOwnedPaths(store.path(), entry.paths());
      record = PackStore.without(record, id);
      PackStore.write(store.path(), record);
      System.out.println("Removed " + id + " (" + installedAt(store.path(), entry.paths()) + ")");
    }

    // The store stays registered while it still holds something: one entry serves every bundle, so
    // it comes out only when the last one does.
    if (record.bundles().isEmpty()
        && ProjectConfig.unregister(store.configPath(), List.of(store.path()))) {
      System.out.println(
          "  store now empty — unregistered " + store.path() + " from " + store.configPath());
    }
    return 0;
  }

  /**
   * Move a store written by an older tdcv2 to the flat layout, and say what moved.
   *
   * <p>On stderr: {@code pack list} prints a catalogue people pipe, and a one-off notice about the
   * store is not part of it.
   */
  private static void reportMigration(PackStore.Migration migration) {
    List<String> lines = new ArrayList<>();
    lines.add(
        "tdcv2: pack store \"" + migration.store()
            + "\" used the old per-bundle layout; moved it to the flat one.");
    for (PackStore.Move move : migration.moves()) {
      lines.add(
          "  " + move.id() + ": " + move.from() + " → " + String.join(", ", move.to())
              + " (" + move.files() + " files)");
    }
    if (migration.droppedDataPaths() > 0) {
      lines.add("  dropped " + migration.droppedDataPaths() + " per-bundle dataPaths entries");
    }
    if (migration.registered() != null) {
      lines.add("  registered " + migration.registered() + " instead");
    }
    List<String> leftovers = migration.leftovers();
    if (!leftovers.isEmpty()) {
      String shown = String.join(", ", leftovers.subList(0, Math.min(3, leftovers.size())));
      String more = leftovers.size() > 3 ? ", … and " + (leftovers.size() - 3) + " more" : "";
      lines.add("  left where they were (not pack data): " + shown + more);
    }
    System.err.println(String.join("\n", lines));
  }

  private static String megabytes(long bytes) {
    return String.format(Locale.ROOT, "%.1f MB", bytes / 1024.0 / 1024.0);
  }
}
