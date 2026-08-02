package io.github.nickliapin.tdc.cli;

import io.github.nickliapin.tdc.TDC;
import io.github.nickliapin.tdc.errors.Diagnostic;
import io.github.nickliapin.tdc.errors.DiagnosticRenderer;
import io.github.nickliapin.tdc.errors.TdcDiagnosticException;
import io.github.nickliapin.tdc.formatter.TdcFormatter;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * {@code tdcv2} — the command line.
 *
 * <p>The library is the recommended way to embed TDC; this exists so that a {@code .tdc} file can
 * be run without writing a program around it, and so that a Java user never needs another
 * language's toolchain to do it. The surface deliberately matches the TypeScript and Python CLIs
 * flag for flag: the same config run through any of them must behave the same way, including its
 * exit codes.
 *
 * <p>Three commands beyond generating:
 *
 * <ul>
 *   <li>{@code init} — write a {@code tdcv2.config.json}, by asking rather than by making anyone
 *       hand-write JSON
 *   <li>{@code pack} — list, install and remove data packs from the shared registry
 *   <li>{@code check} — validate a config and say nothing when it is fine
 * </ul>
 *
 * <p>Exit codes: 0 fine, 1 the run failed (an invalid config, a refused preflight), 2 the command
 * line itself was wrong.
 */
public final class Main {

  private Main() {}

  public static final String VERSION = "0.1.0";

  private static final String HELP =
      """
      tdcv2 — The Data Constructor

      Usage:
        tdcv2 <input.tdc> [options]       Generate data from a config
        tdcv2 init [--global]             Set up a config (asks where; --yes for defaults)
        tdcv2 pack [list|add|remove <id>] Install / remove data packs (list with no args)
        tdcv2 check <input.tdc>           Validate a config without generating anything
        tdcv2 format [-w] <file.tdc>      Pretty-print a config (-w writes it in place)

      Options:
        -o, --output <path>      Write generated content to <path> (default: stdout)
        --seed <seed>            Override the seed declared in <env>
        --count <n>              Override the count declared in <env>
        --locale <loc>           Override the default locale (default: en)
        --data-path <dir>        Add a data folder for @data/... sources (repeatable)
        --jobs <n>               Worker threads for a large streaming run. By default TDC
                                 uses one per core bar one; the count never changes the
                                 output, only how long it takes.
        --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                                 any size — TDC picks the streaming or exact engine
                                 automatically from the config. memory: the small,
                                 in-RAM engine (an escape hatch; does not scale)
        --disk                   Shortcut for --mode disk (already the default)
        --engine <1|2|3>         Advanced: force a specific engine
        --stream                 Legacy alias for --engine 2
        -h, --help               Show this message
        -v, --version            Show version and exit

      Data paths also come from tdcv2.config.json (nearest one up from the current
      directory) and the global config — { "dataPaths": [...], "locale": ".." }.
      Order of priority: --data-path > project config > global config > bundled packs.

      See https://github.com/NickLiapin/tdcv2 for the DSL reference.
      """;

  public static void main(String[] argv) {
    System.exit(run(Arrays.asList(argv)));
  }

  /** Run the CLI. Returns the exit code rather than calling exit, so tests can drive it. */
  public static int run(List<String> argv) {
    if (!argv.isEmpty() && argv.get(0).equals("init")) {
      return Init.run(argv.subList(1, argv.size()), Path.of("").toAbsolutePath());
    }
    if (!argv.isEmpty() && argv.get(0).equals("pack")) {
      return Pack.run(argv.subList(1, argv.size()), Path.of("").toAbsolutePath());
    }
    if (!argv.isEmpty() && argv.get(0).equals("check")) {
      return check(argv.subList(1, argv.size()));
    }
    if (!argv.isEmpty() && argv.get(0).equals("format")) {
      return format(argv.subList(1, argv.size()));
    }

    Args.Options options;
    try {
      options = Args.parse(argv);
    } catch (Args.UsageException e) {
      fail(e.getMessage(), true);
      return 2;
    }

    if (options.help()) {
      System.out.print(HELP);
      return 0;
    }
    if (options.version()) {
      System.out.println("tdcv2 " + VERSION);
      return 0;
    }
    if (options.input() == null) {
      fail("input file is required", true);
      return 2;
    }
    return generate(options);
  }

  private static int generate(Args.Options options) {
    TDC data;
    try {
      TDC.Options built = TDC.options().configFile(options.input());
      if (options.count() != null) {
        built.count(options.count());
      }
      if (options.seed() != null) {
        built.seed(options.seed());
      }
      if (options.locale() != null) {
        built.locale(options.locale());
      }
      if (!options.dataPaths().isEmpty()) {
        List<Path> roots = new ArrayList<>();
        for (String p : options.dataPaths()) {
          roots.add(Path.of(p));
        }
        built.dataPaths(roots);
      }
      Integer engine = options.engine() != null ? options.engine() : engineFor(options.mode());
      if (engine != null) {
        built.engine(engine);
      }
      data = built.build();
    } catch (TdcDiagnosticException e) {
      report(e.diagnostics(), options.input(), e.source());
      return 1;
    } catch (RuntimeException e) {
      fail(e.getMessage(), false);
      return 1;
    }

    report(data.diagnostics(), options.input(), data.source());

    // A run with no seed anywhere gets a random one. Print it, or the output cannot be reproduced —
    // which is the one promise the whole library is built to keep.
    TDC.SeedInfo seed = data.seedInfo();
    if (seed.generated()) {
      note(
          "no seed specified — using random seed \""
              + seed.seed()
              + "\". Re-run with --seed \""
              + seed.seed()
              + "\" to reproduce this exact output.");
    }

    // Ask what the run will cost before starting it. A config that cannot fit says so in a
    // millisecond here and takes minutes to say so by thrashing.
    Diagnostic budget = data.preflight(options.output() == null);
    if (budget != null) {
      reportOne(budget, options.input(), data.source());
      if (budget.severity() == Diagnostic.Severity.ERROR) {
        return 1;
      }
    }

    try {
      if (options.output() != null) {
        // No --jobs means "decide from the machine". The worker count never changes the bytes —
        // a shard is a range of rows and every row is a function of its own number — so it is
        // safe to pick from the hardware, unlike the engine, which follows from the config.
        data.writeFile(Path.of(options.output()), options.jobs() == null ? 0 : options.jobs());
      } else {
        System.out.print(data);
      }
    } catch (RuntimeException e) {
      fail(e.getMessage(), false);
      return 1;
    }
    return 0;
  }

  /** {@code tdcv2 check <file>} — the validator alone, for an editor or a pre-commit hook. */
  private static int check(List<String> argv) {
    List<String> files = new ArrayList<>();
    for (String arg : argv) {
      if (!arg.startsWith("-")) {
        files.add(arg);
      }
    }
    if (files.size() != argv.size() || files.size() != 1) {
      fail("usage: tdcv2 check <input.tdc>", false);
      return 2;
    }

    TDC data;
    try {
      data = new TDC(files.get(0));
    } catch (TdcDiagnosticException e) {
      report(e.diagnostics(), files.get(0), e.source());
      return 1;
    } catch (RuntimeException e) {
      fail(e.getMessage(), false);
      return 1;
    }

    List<Diagnostic> problems = data.diagnostics();
    report(problems, files.get(0), data.source());
    if (problems.isEmpty()) {
      System.err.println("tdcv2: " + files.get(0) + " is valid");
    }
    return 0;
  }

  /**
   * {@code tdcv2 format [-w] <file.tdc>} — pretty-print a config.
   *
   * <p>Prints to stdout by default; {@code -w} overwrites the file. A file with a syntax error is
   * reported and left alone: reformatting something that cannot be parsed would be a guess about
   * what the author meant.
   */
  private static int format(List<String> argv) {
    boolean write = false;
    List<String> files = new ArrayList<>();
    for (String arg : argv) {
      if (arg.equals("-w") || arg.equals("--write")) {
        write = true;
      } else if (arg.equals("-h") || arg.equals("--help")) {
        System.out.println("Usage: tdcv2 format [-w|--write] <file.tdc>");
        return 0;
      } else if (arg.startsWith("-")) {
        fail("format: unknown option: " + arg, false);
        return 2;
      } else {
        files.add(arg);
      }
    }

    if (files.size() != 1) {
      fail("format: a .tdc file is required", false);
      return 2;
    }

    Path path = Path.of(files.get(0));
    String source;
    try {
      source = java.nio.file.Files.readString(path);
    } catch (java.io.IOException e) {
      fail("format: cannot read " + files.get(0) + ": " + e.getMessage(), false);
      return 1;
    }

    // Never format a file we cannot fully parse — report the syntax error instead.
    var parsed = io.github.nickliapin.tdc.parser.TdcParserFacade.parse(source);
    if (!parsed.ok()) {
      List<Diagnostic> problems = new ArrayList<>();
      for (var problem : parsed.problems()) {
        problems.add(
            Diagnostic.error("TDC001", problem.message(), "", problem.line(), problem.column()));
      }
      report(problems, files.get(0), source);
      return 1;
    }

    String formatted = TdcFormatter.format(source);
    if (!write) {
      System.out.print(formatted);
      return 0;
    }

    try {
      if (!formatted.equals(source)) {
        // Write beside the file and rename over it: a crash mid-write must
        // not leave the user's config truncated.
        java.nio.file.Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
        java.nio.file.Files.writeString(tmp, formatted);
        java.nio.file.Files.move(
            tmp, path, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        note("formatted " + files.get(0));
      } else {
        note(files.get(0) + " is already formatted");
      }
    } catch (java.io.IOException e) {
      fail("format: cannot write " + files.get(0) + ": " + e.getMessage(), false);
      return 1;
    }
    return 0;
  }

  /** {@code --mode memory} is the in-memory engine by name; {@code disk} is the default already. */
  private static Integer engineFor(String mode) {
    return "memory".equals(mode) ? Integer.valueOf(1) : null;
  }

  /** Diagnostics to stderr, so they stay out of a piped or redirected run's data. */
  private static void report(List<Diagnostic> problems, String filename, String source) {
    if (problems.isEmpty()) {
      return;
    }
    System.err.println(
        DiagnosticRenderer.formatAll(
            problems, source, filename == null ? "<input>" : filename, false));
  }

  private static void reportOne(Diagnostic problem, String filename, String source) {
    System.err.println(
        DiagnosticRenderer.format(problem, source, filename == null ? "<input>" : filename, false));
  }

  static void fail(String message, boolean usage) {
    System.err.println("tdcv2: " + message);
    if (usage) {
      System.err.println("Run `tdcv2 --help` for usage.");
    }
  }

  static void note(String message) {
    System.err.println("tdcv2: " + message);
  }
}
