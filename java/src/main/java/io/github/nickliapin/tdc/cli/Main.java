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

  /**
   * The version, taken from the build rather than written down a second time.
   *
   * <p>A constant maintained by hand is a number that agrees with itself and with nothing else: a
   * release bumped the build's version and left this one behind, so {@code tdcv2 --version}
   * reported a number no artefact ever carried. {@code BuildInfo} is generated from that one
   * declaration, so the two can no longer disagree.
   */
  public static final String VERSION = BuildInfo.VERSION;

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
        --now <date>             Pin the clock date generators read as "now" —
                                 YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss, always UTC.
                                 Without it the run reads the real clock, so a config
                                 using today / now / b_day cannot be reproduced later
        --data-path <dir>        Add a data folder for @data/... sources (repeatable)
        --jobs <n>               Worker threads for a large streaming run. Needs -o:
                                 stdout is written by one thread. By default TDC uses
                                 one per core bar one. The count never changes the
                                 output, but it does change the cost: each thread
                                 keeps its own buffers, so memory grows with it.
                                 Use --jobs 1 when memory matters more than time.
        --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                                 any size — TDC picks the streaming or exact engine
                                 automatically from the config. memory: the small,
                                 in-RAM engine (an escape hatch; does not scale)
        --disk                   Shortcut for --mode disk (already the default)
        --progress               Write <output>.progress — a small JSON status file
                                 refreshed about once a second (phase, rows done,
                                 percent). Needs -o. Poll it, or watch its mtime as
                                 a heartbeat: not updated for minutes = not running
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

  /**
   * What to say when the config named on the command line is not there.
   *
   * <p>Byte-identical in all five: it is one command with five front ends, and a reader who
   * hits this in one must not get less help in the next.
   */
  static String missingConfigMessage(String file) {
    return "tdcv2: no config file at \"" + file + "\"\n\n"
        + "  `tdcv2 init` writes a config and three worked examples into this folder,\n"
        + "  then prints the command that runs the first one.\n";
  }

  private static int generate(Args.Options options) {
    // Checked here rather than left to the reader: this is the first error a newcomer can hit
    // and it used to be the worst one in the product — a bare "cannot read config" with no
    // code, no hint and no mention of the command that would have created something to run.
    if (options.input() != null && !java.nio.file.Files.exists(java.nio.file.Path.of(options.input()))) {
      System.err.print(missingConfigMessage(options.input()));
      return 1;
    }

    StatusFile status = null;
    if (options.progress()) {
      if (options.output() == null) {
        System.err.print("tdcv2: --progress needs -o (the status file lives beside the output)\n");
        return 2;
      }
      status = new StatusFile(Path.of(options.output() + ".progress"));
    }

    TDC data;
    try {
      TDC.Options built = TDC.options().configFile(options.input());
      if (status != null) {
        built.onProgress(status::report);
      }
      if (options.count() != null) {
        built.count(options.count());
      }
      if (options.seed() != null) {
        built.seed(options.seed());
      }
      if (options.locale() != null) {
        built.locale(options.locale());
      }
      if (options.now() != null) {
        built.now(options.now());
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

      int code = produce(data, options);
      if (code == 0 && status != null) {
        status.finish();
      }
      return code;
    } catch (TdcDiagnosticException e) {
      report(e.diagnostics(), options.input(), e.source());
      return 1;
    } catch (RuntimeException e) {
      fail(e.getMessage(), false);
      return 1;
    }
  }

  /**
   * The {@code --progress} status file: one small JSON object, rewritten in place.
   *
   * <p>Written atomically (temp + rename) so a poller never reads half a JSON, and throttled to
   * about once a second so watching costs nothing. The file itself is the heartbeat — an mtime
   * that stops moving for minutes means the process is gone, whatever the content says. On success
   * the last write says {@code "phase":"done"} with the wall-clock seconds the run took.
   *
   * <p>A run split across workers is counted whole: every shard reports the rows it has written
   * and the coordinator adds them up, so the percent is the FILE's, not one worker's.
   */
  private static final class StatusFile {

    private final Path path;
    private final long startedAt = System.currentTimeMillis();
    private volatile long lastWrite;
    /** The last object written, so the heartbeat can repeat it with a fresh stamp. */
    private volatile String last;
    private final java.util.Timer beat = new java.util.Timer("tdc-progress", true);

    StatusFile(Path path) {
      this.path = path;
      // The file exists from the first moment, under a phase that is TRUE. A watcher that finds
      // no file cannot tell "not started yet" from "died", and this moment used to be marked
      // `render` — a phase still ahead of the work.
      write("{\"phase\":\"starting\",\"percent\":0,\"startedAt\":" + startedAt
          + ",\"updatedAt\":" + startedAt + ",\"pid\":" + ProcessHandle.current().pid() + "}");
      /*
       * The heartbeat, which used to be a promise the file could not keep.
       *
       * Nothing wrote unless a phase reported, and a phase that is working reports nothing, so a
       * healthy run could leave the file untouched for over two minutes — long enough for a
       * watcher following the reference page to call it dead. The last state is rewritten with a
       * fresh `updatedAt` whenever a second passes with no report.
       */
      beat.scheduleAtFixedRate(new java.util.TimerTask() {
        @Override
        public void run() {
          String payload = last;
          long now = System.currentTimeMillis();
          if (payload == null || now - lastWrite < 1000) {
            return;
          }
          write(payload.replaceFirst(
              ",\"updatedAt\":[0-9]+", java.util.regex.Matcher.quoteReplacement(
                  ",\"updatedAt\":" + now)));
        }
      }, 1000L, 1000L);
    }

    private void write(String payload) {
      Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
      try {
        java.nio.file.Files.writeString(tmp, payload + "\n");
        java.nio.file.Files.move(tmp, path, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
      } catch (java.io.IOException e) {
        // A status file nobody can write is not a reason to lose the run it describes.
      }
      lastWrite = System.currentTimeMillis();
      last = payload;
    }

    void report(String phase, int done, int total) {
      long now = System.currentTimeMillis();
      // A finished phase is always written, throttle or not: forty-four piles can finish inside
      // one second, and the throttle then dropped every report after the first — leaving the file
      // saying "1 of 44" while the run had moved on.
      if (done != total && now - lastWrite < 1000) {
        return;
      }
      double percent = total > 0 ? Math.round((double) done / total * 1000) / 10.0 : 0;
      write(
          "{\"phase\":\"" + phase + "\",\"done\":" + done + ",\"total\":" + total
              + ",\"percent\":" + number(percent) + ",\"startedAt\":" + startedAt
              + ",\"updatedAt\":" + now + ",\"pid\":" + ProcessHandle.current().pid() + "}");
    }

    void finish() {
      beat.cancel();
      long now = System.currentTimeMillis();
      write(
          "{\"phase\":\"done\",\"percent\":100,\"startedAt\":" + startedAt
              + ",\"updatedAt\":" + now
              + ",\"elapsedSeconds\":" + Math.round((now - startedAt) / 1000.0)
              + ",\"pid\":" + ProcessHandle.current().pid() + "}");
    }

    /** A whole percentage prints without its ".0", the way every other runtime writes it. */
    private static String number(double value) {
      return value == Math.rint(value)
          ? String.valueOf((long) value)
          : String.valueOf(value);
    }
  }

  /**
   * Everything after the config is built: report, seed note, preflight, write.
   *
   * <p>Split out so it sits INSIDE the caller's try rather than between two of them. It used to
   * sit between, and the engine router throws from {@code preflight} — so a plain
   * {@code mode="nonsense"} escaped both catches and printed a Java stack trace where the
   * reference prints one line. The reader saw "the program broke" instead of "your config is
   * wrong", with our own file names as the evidence.
   */
  private static int produce(TDC data, Args.Options options) {
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

    if (options.output() != null) {
      // No --jobs means "decide from the machine". The worker count never changes the bytes —
      // a shard is a range of rows and every row is a function of its own number — so it is
      // safe to pick from the hardware, unlike the engine, which follows from the config.
      data.writeFile(Path.of(options.output()), options.jobs() == null ? 0 : options.jobs());
    } else {
      // A worker owns a RANGE of rows and writes it at a known offset in the file. stdout has
      // no offsets — it is one stream, in order — so there is nothing for a second worker to
      // write into. Say so: a flag accepted and quietly dropped teaches the user that they
      // asked for threads and got them, and they will believe the timing they measure.
      //
      // Only for an explicit number ABOVE one, the way the reference does it: `--jobs 1` asks
      // for the single thread stdout already uses, and has therefore lost nothing.
      if (options.jobs() != null && options.jobs() > 1) {
        note("--jobs needs -o and is ignored writing to stdout — running single-threaded.");
      }

      System.out.print(data);
    }

    return 0;
  }

  /** {@code tdcv2 check <file>} — the validator alone, for an editor or a pre-commit hook. */
  private static int check(List<String> argv) {
    // `--brief` prints one line per diagnostic and no source excerpt: an editor listing
    // errors in a panel wants rows, not a picture of the file.
    boolean brief = argv.contains("--brief");
    List<String> files = new ArrayList<>();
    boolean unknownFlag = false;
    for (String arg : argv) {
      if (!arg.startsWith("-")) {
        files.add(arg);
      } else if (!"--brief".equals(arg)) {
        unknownFlag = true;
      }
    }
    if (unknownFlag || files.size() != 1) {
      fail("usage: tdcv2 check [--brief] <input.tdc>", false);
      return 2;
    }

    TDC data;
    try {
      data = new TDC(files.get(0));
    } catch (TdcDiagnosticException e) {
      report(e.diagnostics(), files.get(0), e.source(), brief);
      return 1;
    } catch (RuntimeException e) {
      fail(e.getMessage(), false);
      return 1;
    }

    List<Diagnostic> problems = data.diagnostics();
    report(problems, files.get(0), data.source(), brief);
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
    report(problems, filename, source, false);
  }

  private static void report(
      List<Diagnostic> problems, String filename, String source, boolean brief) {
    if (problems.isEmpty()) {
      return;
    }
    if (brief) {
      StringBuilder out = new StringBuilder();
      for (Diagnostic d : problems) {
        if (out.length() > 0) {
          out.append('\n');
        }
        out.append(briefLine(d));
      }
      System.err.println(out);
      return;
    }
    System.err.println(
        DiagnosticRenderer.formatAll(
            problems, source, filename == null ? "<input>" : filename, false));
  }

  /**
   * One diagnostic on one line: code, position, message, hint after {@code ::}.
   *
   * <p>The hint is kept because it carries the list of what IS allowed, which is the half a
   * reader — or a model — acts on. No trailing count either, so a caller parsing rows need
   * not skip a sentence at the end.
   */
  private static String briefLine(Diagnostic d) {
    String code = d.code() == null || d.code().isEmpty()
        ? (d.severity() == Diagnostic.Severity.WARNING ? "WARN" : "ERROR")
        : d.code();
    String hint = d.hint() == null || d.hint().isEmpty() ? "" : " :: " + d.hint();
    return code + " " + d.line() + ":" + d.column() + " " + d.message() + hint;
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
