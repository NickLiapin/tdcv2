package io.github.nickliapin.tdc.cli;

import io.github.nickliapin.tdc.packs.ProjectConfig;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * {@code tdcv2 init} — create a config file by asking, rather than by making anyone hand-write
 * JSON.
 *
 * <p>People want to generate data, not learn a config format. At a real terminal this asks three
 * questions — where the config should live, where downloaded packs go, which locale — and writes
 * the file. With no console, in a script or in CI, it takes the answers from flags instead, so it
 * stays scriptable and testable.
 *
 * <p>The decisions are pure static methods; the questions are a thin shell over them. That is what
 * the tests exercise, because a prompt is hard to test and a decision is not.
 */
public final class Init {

  private Init() {}

  private static final String USAGE =
      """
      Usage: tdcv2 init [options]

        -g, --global          Write the per-user config instead of a project one
        -y, --yes             Take the defaults, ask nothing
        -f, --force           Overwrite an existing config
        --locale <loc>        Default locale for the config (default: en)
        --data-path <dir>     Folder for downloaded packs
      """;

  /** A command line {@code init} cannot obey. */
  public static final class InitException extends RuntimeException {

    private static final long serialVersionUID = 1L;
    public InitException(String message) {
      super(message);
    }
  }

  /** Everything decided, nothing written yet. */
  public record Plan(Path path, Path packStore, String locale, boolean isGlobal) {}

  /** Where the config goes: the project's own folder, or the per-user location. */
  public static Path configTarget(boolean isGlobal, Path cwd) {
    if (!isGlobal) {
      return cwd.toAbsolutePath().normalize().resolve(ProjectConfig.PROJECT_CONFIG_NAME);
    }
    Path target = ProjectConfig.globalConfigPath();
    if (target == null) {
      throw new InitException("no global config location on this platform — use a project config");
    }
    return target;
  }

  /** A project keeps packs beside its config; the global config keeps them next to itself. */
  public static Path defaultPackStore(boolean isGlobal, Path configPath, Path cwd) {
    return isGlobal
        ? configPath.getParent().resolve("packs")
        : cwd.toAbsolutePath().normalize().resolve("tdcv2-packs");
  }

  /**
   * The file's JSON.
   *
   * <p>The store is written as {@code packStore}, not as a {@code dataPaths} entry: it is where
   * {@code pack add} downloads bundles, and it is deliberately not a scan root on its own — each
   * installed bundle registers its own {@code packs} folder, so that addresses stay {@code
   * en.person.lastName} rather than {@code en.packs.en.person.lastName}. A project config stores
   * the path relative, so the file can be checked into git and still work on another machine; a
   * global config is machine-specific by nature and stores it absolute.
   */
  public static String configContent(Plan plan) {
    String store =
        plan.isGlobal()
            ? plan.packStore().toString()
            : relativeTo(plan.path().getParent(), plan.packStore());
    return "{\n  \"packStore\": \""
        + escape(store)
        + "\",\n  \"locale\": \""
        + escape(plan.locale())
        + "\"\n}\n";
  }

  private static String relativeTo(Path base, Path target) {
    Path absolute = target.toAbsolutePath().normalize();
    Path root = base.toAbsolutePath().normalize();
    if (absolute.equals(root)) {
      return ".";
    }
    if (absolute.startsWith(root)) {
      return "./" + root.relativize(absolute).toString().replace('\\', '/');
    }
    return absolute.toString();
  }

  private static String escape(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }

  /** Write it, and create the pack folder so {@code pack add} has somewhere to go. */
  public static void writeConfig(Plan plan, boolean force) {
    if (Files.exists(plan.path()) && !force) {
      throw new InitException(
          "config already exists at \""
              + plan.path()
              + "\" — pass --force to overwrite, or edit it directly");
    }
    try {
      Files.createDirectories(plan.path().getParent());
      Files.writeString(plan.path(), configContent(plan), StandardCharsets.UTF_8);
      Files.createDirectories(plan.packStore());
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  /** What the flags said. */
  public record Flags(
      boolean isGlobal, boolean force, boolean yes, String locale, String packStore) {}

  public static Flags parseFlags(List<String> argv) {
    boolean isGlobal = false;
    boolean force = false;
    boolean yes = false;
    String locale = null;
    String packStore = null;

    for (int i = 0; i < argv.size(); i++) {
      String arg = argv.get(i);
      if (arg.equals("-g") || arg.equals("--global")) {
        isGlobal = true;
      } else if (arg.equals("-f") || arg.equals("--force")) {
        force = true;
      } else if (arg.equals("-y") || arg.equals("--yes")) {
        yes = true;
      } else if (arg.startsWith("--locale=")) {
        locale = arg.substring("--locale=".length());
      } else if (arg.startsWith("--data-path=")) {
        packStore = arg.substring("--data-path=".length());
      } else if (arg.equals("--locale") || arg.equals("--data-path")) {
        i++;
        if (i >= argv.size()) {
          throw new InitException("missing value for " + arg);
        }
        if (arg.equals("--locale")) {
          locale = argv.get(i);
        } else {
          packStore = argv.get(i);
        }
      } else {
        throw new InitException("unknown option for init: " + arg);
      }
    }
    return new Flags(isGlobal, force, yes, locale, packStore);
  }

  public static Plan planFromFlags(Flags flags, Path cwd) {
    Path path = configTarget(flags.isGlobal(), cwd);
    Path store =
        flags.packStore() != null
            ? cwd.resolve(flags.packStore()).toAbsolutePath().normalize()
            : defaultPackStore(flags.isGlobal(), path, cwd);
    return new Plan(path, store, flags.locale() == null ? "en" : flags.locale(), flags.isGlobal());
  }

  public static int run(List<String> argv, Path cwd) {
    if (argv.contains("-h") || argv.contains("--help")) {
      System.out.print(USAGE);
      return 0;
    }

    Flags flags;
    try {
      flags = parseFlags(argv);
    } catch (InitException e) {
      System.err.println("tdcv2: " + e.getMessage());
      System.err.println("Run `tdcv2 init --help` for usage.");
      return 2;
    }

    // No console means no terminal to ask at — a pipe, a script, a CI job. `System.console()` is
    // null in exactly those cases, which is the question being asked.
    boolean interactive = System.console() != null && !flags.yes();

    Plan plan;
    try {
      plan = interactive ? ask(flags, cwd) : planFromFlags(flags, cwd);
    } catch (InitException e) {
      System.err.println("tdcv2: " + e.getMessage());
      return 2;
    }

    try {
      writeConfig(plan, flags.force());
    } catch (InitException | UncheckedIOException e) {
      System.err.println("tdcv2: " + e.getMessage());
      return 2;
    }

    System.out.println(
        "Wrote " + (plan.isGlobal() ? "global" : "project") + " config: " + plan.path());
    System.out.println("  data packs → " + plan.packStore());
    System.out.println("  locale     → " + plan.locale());

    // Examples land beside the config, which for a global init is the user's home —
    // not what anyone wants. A project init is the one that gets them.
    List<String> examples =
        plan.isGlobal() ? List.<String>of() : writeExamples(plan.path().getParent());

    if (examples.isEmpty()) {
      System.out.println();
      System.out.println("Next: run `tdcv2 pack` to download data packs into that folder.");
    } else {
      System.out.println("  examples   → " + String.join(", ", examples));
      System.out.println();
      System.out.println("Next: run it.");
      System.out.println("    tdcv2 " + examples.get(0));
      System.out.println();
      System.out.println("The common, en and USA packs are already inside this install, so the");
      System.out.println("examples run with nothing downloaded. `tdcv2 pack` adds more locales.");
    }
    return 0;
  }

  /** Where {@code init} puts the worked examples, beside the config it writes. */
  static final String EXAMPLES_DIR_NAME = "tdcv2-examples";

  /**
   * Write the worked examples next to the config, and say what was written.
   *
   * <p>{@code init} used to leave a reader with a config file and no way to see output: it printed
   * "Next: run `tdcv2 pack`" and there was still no {@code .tdc} anywhere. Every documented first
   * command named a {@code demo.tdc} that nothing created, so the very first command a newcomer
   * typed could only fail.
   */
  static List<String> writeExamples(Path intoDir) {
    Path target = (intoDir == null ? Path.of(".") : intoDir).resolve(EXAMPLES_DIR_NAME);
    List<String> written = new ArrayList<>();
    try {
      Files.createDirectories(target);
      for (String[] example : ExamplesGenerated.EXAMPLES) {
        Path path = target.resolve(example[0]);
        // A second `init` must not overwrite an example someone has been editing.
        if (!Files.exists(path)) {
          Files.writeString(path, example[1], StandardCharsets.UTF_8);
        }
        written.add(EXAMPLES_DIR_NAME + "/" + example[0]);
      }
    } catch (IOException e) {
      return List.of();
    }
    return written;
  }

  private static Plan ask(Flags flags, Path cwd) {
    BufferedReader in =
        new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));

    boolean isGlobal = flags.isGlobal();
    if (flags.packStore() == null && !flags.isGlobal()) {
      System.out.println("Where should this config live?");
      System.out.println("  1) This project — a tdcv2.config.json here, check it into git");
      System.out.println("  2) Global — all your projects, in your home folder");
      isGlobal = "2".equals(read(in, "Choice [1]: "));
    }

    Path path = configTarget(isGlobal, cwd);
    Path suggested =
        flags.packStore() != null
            ? cwd.resolve(flags.packStore()).toAbsolutePath().normalize()
            : defaultPackStore(isGlobal, path, cwd);

    String typed = read(in, "Folder for downloaded data packs [" + suggested + "]: ");
    Path store = typed.isEmpty() ? suggested : cwd.resolve(typed).toAbsolutePath().normalize();

    String fallback = flags.locale() == null ? "en" : flags.locale();
    String locale = read(in, "Default locale [" + fallback + "]: ");
    return new Plan(path, store, locale.isEmpty() ? fallback : locale, isGlobal);
  }

  private static String read(BufferedReader in, String prompt) {
    System.out.print(prompt);
    System.out.flush();
    try {
      String line = in.readLine();
      return line == null ? "" : line.trim();
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
