package io.github.nickliapin.tdc;

import io.github.nickliapin.tdc.engine.DiskEngine;
import io.github.nickliapin.tdc.engine.EngineRouter;
import io.github.nickliapin.tdc.engine.MemoryEngine;
import io.github.nickliapin.tdc.engine.RowSource;
import io.github.nickliapin.tdc.engine.StreamEngine;
import io.github.nickliapin.tdc.errors.Diagnostic;
import io.github.nickliapin.tdc.errors.TdcDiagnosticException;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.packs.DataPacks;
import io.github.nickliapin.tdc.packs.ProjectConfig;
import io.github.nickliapin.tdc.parser.ConfigBuilder;
import io.github.nickliapin.tdc.parser.TdcParserFacade;
import io.github.nickliapin.tdc.validator.Validator;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Generate data from a {@code .tdc} config.
 *
 * <p>The entry point. Point it at a file or hand it the config as a string, then take the result
 * as text or as rows:
 *
 * <pre>{@code
 * var data = new TDC("users.tdc");
 * System.out.println(data);
 *
 * for (TDC.Row row : data.iterate()) {
 *     System.out.println(row.get("Gender"));
 * }
 * }</pre>
 *
 * <p>Rows are the reason to use the library rather than the command line. A test that asserts on
 * {@code row.get("Gender")} says what it means; the same test parsing CSV back out of a string
 * spends most of its lines on the parsing.
 *
 * <p>Text output and row output read the same generated values, so the two never disagree. Row
 * output ignores {@code <block>} and the wrappers entirely — those describe a file format, and a
 * row has no format.
 */
public final class TDC {

  private final Config config;
  private final String source;
  private final DataPacks packs;

  /**
   * Whether the seed was invented here because nothing declared one.
   *
   * <p>Stored rather than inferred from an empty seed: once one is generated the config carries it
   * like any other, and "is it empty" would then answer no to a question it used to answer yes to.
   */
  private final boolean seedGenerated;

  /**
   * How to build ANOTHER set of packs, identical to this run's.
   *
   * <p>Parallel generation needs one per thread: packs cache what they load in a plain map, and a
   * map filled from several threads at once is a data race that would surface as one wrong value
   * in a hundred million rows.
   */
  private final java.util.function.Supplier<DataPacks> packsFactory;
  private final long nowMillis;
  private final Path baseDir;
  private final List<Diagnostic> diagnostics;

  /** A materialized cell, roughly: a short string plus its object header and the slot holding it. */
  private static final int BYTES_PER_CELL = 40;

  /** A rendered record, roughly — enough to notice a run that will not fit. */
  private static final int BYTES_PER_RENDERED_CARD = 200;

  /** Past half the heap the run is worth a word; past nine tenths it is worth stopping for. */
  private static final double WARN_RATIO = 0.5;

  private static final double ERROR_RATIO = 0.9;
  private volatile RowSource rendered;

  /** One record: its sequences, addressable by the names the config gave them. */
  public static final class Row {
    private final RowSource source;
    private final int index;

    private Row(RowSource source, int index) {
      this.source = source;
      this.index = index;
    }

    /**
     * The value of one sequence on this row.
     *
     * @return {@code null} when the sequence does not apply here — a column declared with {@code
     *     parent="Gender.Male"} has no value on a female row, and an empty string would claim it
     *     had one that happened to be blank.
     */
    public String get(String sequence) {
      return source.value(sequence, index);
    }

    /** The 0-based position of this row in the run. */
    public int index() {
      return index;
    }

    /** Every sequence with a value here, in declaration order. */
    public Map<String, String> toMap() {
      Map<String, String> out = new LinkedHashMap<>();
      for (String name : source.sequenceNames()) {
        String value = source.value(name, index);
        if (value != null) {
          out.put(name, value);
        }
      }
      return out;
    }

    /**
     * The same row with compound sequences nested.
     *
     * <p>A compound is one thing with parts, so it reads as one entry holding a map rather than
     * as several sibling entries whose shared prefix the caller has to notice: {@code
     * row.nested().get("Address")} gives the whole address, keyed by field.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> nested() {
      Map<String, Object> out = new LinkedHashMap<>();
      for (Map.Entry<String, String> entry : toMap().entrySet()) {
        int dot = entry.getKey().indexOf('.');
        if (dot < 0) {
          out.put(entry.getKey(), entry.getValue());
          continue;
        }
        String parent = entry.getKey().substring(0, dot);
        String field = entry.getKey().substring(dot + 1);
        Object existing = out.get(parent);
        Map<String, String> group =
            existing instanceof Map ? (Map<String, String>) existing : new LinkedHashMap<>();
        group.put(field, entry.getValue());
        out.put(parent, group);
      }
      return out;
    }

    @Override
    public String toString() {
      return toMap().toString();
    }
  }

  /** What {@link #seedInfo()} reports: the seed used, and whether the config supplied it. */
  public record SeedInfo(String seed, boolean generated) {}

  /**
   * Everything a run needs. Exactly one of {@code configFile} and {@code configString} is
   * required; the rest override what {@code <env>} declares.
   */
  public static final class Options {
    private Path configFile;
    private String configString;
    private Integer count;
    private String seed;
    private String locale;
    private Long now;
    private Path packsDir;
    private List<Path> dataPaths = List.of();
    private Path baseDir;
    private Integer engine;

    public Options configFile(Path value) {
      this.configFile = value;
      return this;
    }

    public Options configFile(String value) {
      return configFile(Path.of(value));
    }

    public Options configString(String value) {
      this.configString = value;
      return this;
    }

    public Options count(int value) {
      this.count = value;
      return this;
    }

    public Options seed(String value) {
      this.seed = value;
      return this;
    }

    public Options locale(String value) {
      this.locale = value;
      return this;
    }

    /**
     * The instant "now" means, in milliseconds since the epoch.
     *
     * <p>Worth setting in a test. A config with a date generator reads the clock, so the same
     * seed produces different data tomorrow — pinning the clock is what makes such a test stable
     * for longer than a day.
     */
    public Options now(long epochMillis) {
      this.now = epochMillis;
      return this;
    }

    /** Where the data packs live. Defaults to the packs the library ships with. */
    public Options packsDir(Path value) {
      this.packsDir = value;
      return this;
    }

    /**
     * Extra pack roots, on top of what the project's config already names.
     *
     * <p>The command line's {@code --data-path}. Unlike {@link #packsDir}, which replaces the
     * lookup entirely, these are layered on last — so they shadow the config's roots and the
     * bundled packs without hiding either.
     */
    public Options dataPaths(List<Path> value) {
      this.dataPaths = List.copyOf(value);
      return this;
    }

    /**
     * The folder a relative {@code src=} inside the config resolves against.
     *
     * <p>Only needed with {@code configString}: a config read from a file is already relative to
     * that file's folder.
     */
    public Options baseDir(Path value) {
      this.baseDir = value;
      return this;
    }

    /**
     * Run on one named engine — 1 in memory, 2 streaming, 3 exact on disk.
     *
     * <p>Overrides everything the config says, and refuses rather than falling back when the
     * engine cannot do what the config asks. That is what makes it useful for a benchmark and
     * wrong for ordinary use, where {@code <env mode>} lets the router choose.
     */
    public Options engine(int value) {
      this.engine = value;
      return this;
    }

    public TDC build() {
      return new TDC(this);
    }
  }

  public static Options options() {
    return new Options();
  }

  /** A config file, everything else from {@code <env>}. */
  public TDC(String configFile) {
    this(new Options().configFile(configFile));
  }

  public TDC(Path configFile) {
    this(new Options().configFile(configFile));
  }

  private TDC(Options options) {
    if ((options.configFile == null) == (options.configString == null)) {
      throw new IllegalArgumentException(
          "TDC needs exactly one of configFile and configString");
    }
    String source =
        options.configString != null ? options.configString : read(options.configFile);

    TdcParserFacade.Result parsed = TdcParserFacade.parse(source);
    if (!parsed.ok()) {
      // Thrown as diagnostics rather than as prose so that a caller — the command line above all
      // — can render the offending line instead of only quoting the message.
      List<Diagnostic> syntax = new ArrayList<>();
      for (TdcParserFacade.SyntaxProblem problem : parsed.problems()) {
        syntax.add(Diagnostic.error("TDC001", problem.message(), "", problem.line(), problem.column()));
      }
      throw new TdcDiagnosticException(syntax, source);
    }
    // A pack directory named outright wins; otherwise the project's own tdcv2.config.json is
    // consulted, so a downloaded pack is found by whichever runtime reads the config next.
    java.nio.file.Path packsRoot = options.packsDir;
    java.nio.file.Path projectDir =
        options.configFile != null
            ? options.configFile.toAbsolutePath().getParent()
            : java.nio.file.Path.of("").toAbsolutePath();
    List<java.nio.file.Path> extraPaths = options.dataPaths;
    this.packsFactory =
        () ->
            packsRoot != null
                ? new DataPacks(packsRoot)
                : DataPacks.forProject(projectDir, extraPaths);
    this.packs = packsFactory.get();

    // Validate before building. A config the reference refuses must be refused here too, or the
    // two implementations disagree about which configs are legal — which is a portability bug
    // even when every value either of them produces is right.
    Path configDir =
        options.baseDir != null
            ? options.baseDir
            : options.configFile != null ? options.configFile.toAbsolutePath().getParent() : null;
    List<Diagnostic> problems = Validator.validate(parsed.tree(), configDir, packs);
    if (Diagnostic.hasErrors(problems)) {
      throw new TdcDiagnosticException(problems, source);
    }
    this.diagnostics = problems;
    this.source = source;

    // The project config's `locale` is the fallback for a config that declares none — the same
    // file the packs came from, so a project that installed `ru` and wrote it down gets Russian
    // without repeating itself in every .tdc.
    Config built =
        ConfigBuilder.build(parsed.tree(), ProjectConfig.load(projectDir).locale())
            .override(options.count, options.seed, options.locale);
    Config chosen =
        options.engine == null ? built : built.withEngine(String.valueOf(options.engine));

    // Nothing named a seed, so one is invented — and USED, which is the whole point. Leaving it
    // empty would make every seedless run produce the same bytes while seedInfo() reported a random
    // seed of "", advice that reproduces nothing. Randomness here is the reference's behaviour: a
    // seedless run is a different sample each time, and the seed reported beside it is how you get
    // that sample back. Shaped like the reference's String(Math.random()) so the value looks the
    // same whichever implementation printed it.
    this.seedGenerated = chosen.seed().isEmpty();
    this.config =
        seedGenerated
            ? chosen.override(null, Double.toString(ThreadLocalRandom.current().nextDouble()), null)
            : chosen;

    // Reading the clock once, here, rather than per value: a run that straddled midnight would
    // otherwise put two different dates in one file from one "today".
    this.nowMillis = options.now != null ? options.now : System.currentTimeMillis();
    // With a config file, a relative src= is relative to that file. With a config string there
    // is no file to be relative to, so the caller says where — and if they do not, the working
    // directory is the only honest answer left.
    this.baseDir =
        options.baseDir != null
            ? options.baseDir
            : options.configFile != null ? options.configFile.toAbsolutePath().getParent() : null;
  }

  /** The whole output as one string. */
  @Override
  public String toString() {
    return run().text();
  }

  /**
   * Write the output to a file, replacing whatever is there.
   *
   * <p>On a streaming engine the records go to the file as they are produced, so this is the one
   * call that can write a run larger than the machine's memory. Asking for the same run as a
   * string first would defeat that, so it does not.
   */
  public void writeFile(Path target) {
    writeFile(target, 1);
  }

  /**
   * The same, across {@code workers} threads.
   *
   * <p>Pass 0 for "decide from the machine". The count never changes the bytes — a shard is a
   * range of rows and every row is a function of its own number — so this is a speed knob and
   * nothing else. It applies only to the streaming engine and only to a run big enough to pay for
   * the threads; anything else quietly uses one, which is slower and never wrong.
   *
   * <p>Parquet is written by one thread whatever is asked: its output is a single framed file with
   * a footer, not a concatenation of pieces.
   */
  public void writeFile(Path target, int workers) {
    boolean parquet =
        target.toString().toLowerCase(java.util.Locale.ROOT).endsWith(".parquet");
    if (!parquet) {
      int count = config.count();
      int resolved =
          io.github.nickliapin.tdc.engine.Parallel.resolveWorkers(
              workers <= 0 ? null : workers,
              io.github.nickliapin.tdc.engine.Parallel.canSplit(config, packs),
              count);
      if (resolved > 1) {
        io.github.nickliapin.tdc.engine.Parallel.writeFile(
            config, packsFactory, nowMillis, baseDir, target, resolved, count);
        return;
      }
    }
    try {
      // A .parquet name asks for the typed binary form. The extension is the whole switch —
      // there is no flag to remember and no second call to make.
      if (target.toString().toLowerCase(java.util.Locale.ROOT).endsWith(".parquet")) {
        try (java.io.OutputStream out =
            new java.io.BufferedOutputStream(Files.newOutputStream(target), 1 << 16)) {
          io.github.nickliapin.tdc.output.ParquetOutput.write(config, run(), out);
        }
        return;
      }
      try (java.io.Writer out =
          new java.io.BufferedWriter(
              new java.io.OutputStreamWriter(Files.newOutputStream(target), StandardCharsets.UTF_8),
              1 << 16)) {
        run().writeTo(out);
      }
    } catch (IOException e) {
      throw new UncheckedIOException("cannot write " + target, e);
    }
  }

  /** Every record, as rows. */
  public List<Row> toList() {
    RowSource result = run();
    List<Row> out = new ArrayList<>(result.count());
    for (int i = 0; i < result.count(); i++) {
      out.add(new Row(result, i));
    }
    return Collections.unmodifiableList(out);
  }

  /**
   * The run as COLUMNS rather than rows, with numbers as numbers.
   *
   * <p>A column comes back as a {@code double[]} only when EVERY cell in it is a finite
   * number, and as a {@code String[]} otherwise — the type therefore says which, and a
   * caller reading a numeric column never has to check for a label hiding in it.
   *
   * <p>All-or-nothing on purpose: an array of doubles cannot hold "no value", and filling
   * the gaps with NaN would put a number nobody generated where a {@code parent=} filter
   * deliberately left nothing. A cell with no value is {@code null} in the string form.
   *
   * <p>Not a way to skip the number-to-string conversion: sequences hold their values as
   * text, so this parses them. It is for the ergonomics, and for not building the whole
   * file as one string first.
   */
  public Map<String, Object> toColumns() {
    RowSource result = run();
    Map<String, Object> out = new LinkedHashMap<>();
    for (String name : result.sequenceNames()) {
      String[] text = new String[result.count()];
      for (int i = 0; i < result.count(); i++) {
        text[i] = result.value(name, i);
      }
      double[] numbers = asFiniteNumbers(text);
      out.put(name, numbers != null ? numbers : text);
    }
    return Collections.unmodifiableMap(out);
  }

  /** Every cell as a finite double, or null when even one of them is not. */
  private static double[] asFiniteNumbers(String[] text) {
    double[] out = new double[text.length];
    for (int i = 0; i < text.length; i++) {
      String cell = text[i];
      if (cell == null || cell.isEmpty()) {
        return null;
      }
      double value;
      try {
        value = Double.parseDouble(cell);
      } catch (NumberFormatException e) {
        return null;
      }
      if (!Double.isFinite(value)) {
        return null;
      }
      out[i] = value;
    }
    return out;
  }

  /** The records one at a time, without building the list. */
  public Iterable<Row> iterate() {
    RowSource result = run();
    return () ->
        new Iterator<>() {
          private int next;

          @Override
          public boolean hasNext() {
            return next < result.count();
          }

          @Override
          public Row next() {
            if (!hasNext()) {
              throw new java.util.NoSuchElementException();
            }
            return new Row(result, next++);
          }
        };
  }

  /** One record by position. */
  public Row getAt(int index) {
    RowSource result = run();
    if (index < 0 || index >= result.count()) {
      throw new IndexOutOfBoundsException(
          "row " + index + " is outside a run of " + result.count());
    }
    return new Row(result, index);
  }

  /**
   * Anything the config was warned about but not refused for.
   *
   * <p>Errors are thrown from the constructor, so whatever is left here is worth saying and not
   * worth stopping for.
   */
  /**
   * The config text this run was built from.
   *
   * <p>Exposed because a diagnostic names a line, and showing that line is what makes the
   * complaint act on rather than look up.
   */
  public String source() {
    return source;
  }

  public List<Diagnostic> diagnostics() {
    return diagnostics;
  }

  /** Whether this config calls a service — which makes the run non-reproducible. */
  public boolean usesHttp() {
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.gen() != null && "http".equals(spec.gen().type())) {
        return true;
      }
      if (spec.isCompound()) {
        for (Config.Field field : spec.fields()) {
          if (field.gen() != null && "http".equals(field.gen().type())) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * What this run is likely to cost in memory, or nothing when the answer is "not much".
   *
   * <p>Worth asking before a large run rather than after: a config that will not fit says so in a
   * millisecond here, and takes minutes to say so by thrashing. The estimate is deliberately
   * crude — a cell is assumed to cost about forty bytes and a rendered record about two hundred —
   * because the decision it informs is "is this the right order of magnitude", not "how many
   * bytes exactly".
   *
   * @param materialized whether the whole output will be held as one string, as {@code
   *     toString()} does. A run written straight to a file does not pay that.
   */
  public Diagnostic preflight(boolean materialized) {
    // A streaming engine holds one row, not the run, so its cost does not grow with count.
    boolean streaming = engine() != 1;
    long slots = 4; // _count, _first, _last, _total
    for (Config.SequenceSpec spec : config.sequences()) {
      slots += spec.isCompound() ? spec.fields().size() : 1;
    }
    long cells = streaming ? slots : (long) config.count() * slots;
    long sequenceBytes = cells * BYTES_PER_CELL;
    long outputBytes =
        !streaming && materialized ? (long) config.count() * BYTES_PER_RENDERED_CARD : 0;

    long estimated = sequenceBytes + outputBytes;
    long total = Runtime.getRuntime().maxMemory();
    double ratio = total > 0 ? (double) estimated / total : Double.POSITIVE_INFINITY;
    if (ratio < WARN_RATIO) {
      return null;
    }

    long estMb = (estimated + 1024 * 1024 - 1) / (1024 * 1024);
    long totalMb = total / (1024 * 1024);
    if (ratio >= ERROR_RATIO) {
      return Diagnostic.error(
          "TDC201",
          "estimated memory need (~" + estMb + " MB) exceeds this machine's RAM ("
              + totalMb + " MB) — run will likely thrash or crash",
          "Reduce count, split the generation into smaller batches, or switch to disk mode "
              + "(mode=\"disk\") which is bounded-memory.",
          1, 0);
    }
    return Diagnostic.warning(
        "TDC200",
        "estimated memory need (~" + estMb + " MB) is a large share of this machine's RAM ("
            + totalMb + " MB) — may lean on swap and slow down",
        "This will still run; for very large datasets mode=\"disk\" keeps memory flat "
            + "regardless of count.",
        1, 0);
  }

  /** The same check for the common case: the whole output held as one string. */
  public Diagnostic preflight() {
    return preflight(true);
  }

  /** The number of records this run produces. */
  public int count() {
    return config.count();
  }

  /**
   * The seed in effect. {@code generated} is true when the config named no seed, in which case
   * the run is not reproducible — worth logging, since that is usually not what was wanted.
   */
  public SeedInfo seedInfo() {
    return new SeedInfo(config.seed(), seedGenerated);
  }

  /**
   * Which engine this config runs on: 1 in memory, 2 streaming, 3 exact on disk.
   *
   * <p>Worth exposing because it explains the run's memory profile, and because a config that
   * asked for disk mode and got engine 1 back is being told something useful — it uses a feature
   * that has to see the whole column.
   */
  public int engine() {
    return EngineRouter.resolve(config, packs);
  }

  /** The parsed config, for an output format that needs the schema as well as the values. */
  Config config() {
    return config;
  }

  /** The built run, for the same reason. */
  RowSource rows() {
    return run();
  }

  /** Generated once and kept: asking for text and then for rows must not run the generator twice. */
  private RowSource run() {
    RowSource local = rendered;
    if (local == null) {
      synchronized (this) {
        local = rendered;
        if (local == null) {
          local = build();
          rendered = local;
        }
      }
    }
    return local;
  }

  /**
   * Whether the config named its engine rather than describing its constraint.
   *
   * <p>{@code engine="2"} and the older {@code mode="stream"} both say which engine to use. That
   * makes a refusal the answer: silently running elsewhere would hide exactly what the author
   * asked to be told. {@code mode="disk"} says what the run may cost instead, so falling back to
   * a slower engine honours it.
   */
  private boolean forcedEngine() {
    String engine = config.engine();
    return (engine != null && !engine.isBlank()) || "stream".equals(trim(config.mode()));
  }

  private static String trim(String value) {
    return value == null ? null : value.trim();
  }

  private RowSource build() {
    int engine = engine();
    if (engine == 1) {
      return MemoryEngine.build(config, packs, nowMillis, baseDir);
    }
    if (engine == 3) {
      // Engine 3 falls back on its own, so a config it cannot do exactly still renders.
      return DiskEngine.rows(config, packs, nowMillis, baseDir);
    }
    try {
      return StreamEngine.rows(config, packs, nowMillis, baseDir);
    } catch (StreamEngine.Unsupported e) {
      if (forcedEngine()) {
        throw e; // named outright, so the refusal is the answer
      }
      // Routed here rather than asked for: the config turned out to need the whole column after
      // all, and correct data matters more than the memory profile.
      return MemoryEngine.build(config, packs, nowMillis, baseDir);
    }
  }

  private static String read(Path file) {
    try {
      return Files.readString(file);
    } catch (IOException e) {
      throw new UncheckedIOException("cannot read config " + file, e);
    }
  }
}
