package io.github.nickliapin.tdc.packs;

import io.github.nickliapin.tdc.errors.Diagnostic;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reads data packs off disk.
 *
 * <p>A pack is a text file: an optional {@code ---} header, then one value per line. With
 * {@code weighted: true} each line is {@code value,count} instead, and the counts become exact
 * proportions rather than probabilities — the same machinery {@code percent=} uses. That is
 * why a run of 30,000 rows from the SSA name file contains precisely as many Jameses as the
 * census says, not approximately.
 */
public final class DataPacks {

  /**
   * The extensions a dotted address is tried against, in order.
   *
   * <p>Nearly every pack is a {@code .txt} list; a COMPOSED pack — one whose value a generator
   * body builds rather than a line of the file — is a {@code .tdc}. The reference ignores the
   * extension altogether, and so does the address index below; this list is only the fast path
   * that spares an ordinary run the scan.
   */
  private static final String[] PACK_EXTENSIONS = {".txt", ".tdc"};

  /**
   * A relative path without its final extension, the way the reference derives an address from
   * one. Only the last segment is considered, so {@code nl-be/person/name} keeps the dot in its
   * folder.
   */
  private static String stripExtension(String path) {
    int start = path.lastIndexOf('/') + 1;
    int dot = path.lastIndexOf('.');
    return dot > start ? path.substring(0, dot) : path;
  }

  /**
   * A loaded pack.
   *
   * <p>{@code percents} is null unless the pack is weighted. {@code generator} is null unless
   * the pack is a generator rather than a list — some packs describe how to build a value
   * instead of listing values, because listing every UUID is not a thing anyone can do.
   */
  public record Entry(List<String> values, double[] percents, String generator) {
    public boolean weighted() {
      return percents != null;
    }

    public boolean isGenerator() {
      return generator != null;
    }
  }

  private final PackSource source;
  private final Map<String, Entry> cache = new HashMap<>();

  /**
   * address -&gt; relative file path, built on the first miss and kept.
   *
   * <p>Null until then: most runs resolve every address straight from its path and never pay for
   * the scan.
   */
  private Map<String, String> addressIndex;

  /**
   * The files the index build read and could not place — TDC171.
   *
   * <p>Filled by the same pass, so saying so costs nothing over dropping them silently.
   */
  private List<Diagnostic> unaddressable = List.of();

  /**
   * Folders searched by {@code src="@data/…"}, and by a relative {@code src=} the config's own
   * folder does not hold. Highest priority last, as the layers are.
   *
   * <p>They live here because they answer the same question the packs do and come from the same
   * place — {@code --data-path} on the command line, {@code dataPaths} in the project config —
   * and because every engine and the validator is already handed a {@code DataPacks}, so nothing
   * new has to be threaded through fifteen signatures.
   */
  private final List<Path> dataRoots;

  /** The folders a file source may name. Empty when none were configured. */
  public List<Path> dataRoots() {
    return dataRoots;
  }

  public DataPacks(PackSource source, List<Path> dataRoots) {
    this.source = source;
    this.dataRoots = List.copyOf(dataRoots);
  }

  public DataPacks(PackSource source) {
    this(source, List.of());
  }

  public DataPacks(Path root) {
    this(new PackSource.Directory(root));
  }

  /**
   * The packs a run starts from — the default, and no configuration needed to use it.
   *
   * <p>{@code TDCV2_PACKS} if it names a folder, then the source checkout this build came from,
   * then the starter set inside the jar. See {@link #discover()}.
   */
  public static DataPacks bundled() {
    return new DataPacks(discover());
  }

  /**
   * Where a run's packs come from before any config or command line adds to them — the same
   * three questions, in the same order, in all five implementations.
   *
   * <ol>
   *   <li>{@code TDCV2_PACKS}, if it names a directory. Written down by hand, so it wins.
   *   <li>The TDC source checkout this build came from, if there is one. In a checkout that is
   *       the copy every implementation reads and the one a contributor edits, so all five see
   *       the same data rather than five copies free to drift.
   *   <li>The starter set inside the jar, which is what a dependency resolved from Maven Central
   *       has: there is nothing above {@code ~/.m2} to walk up to.
   * </ol>
   */
  static PackSource discover() {
    String fromEnv = System.getenv("TDCV2_PACKS");
    if (fromEnv != null && !fromEnv.isBlank() && Files.isDirectory(Path.of(fromEnv))) {
      return new PackSource.Directory(Path.of(fromEnv));
    }
    Path checkout = sourceCheckoutPacks(ownLocation());
    if (checkout == null) {
      return new PackSource.Classpath();
    }
    // Layered rather than replaced. The classpath is not only this jar's own starter set: any
    // dependency may carry a pack index, which is how a Java project adds a locale by adding an
    // artifact instead of running a downloader. Dropping it for the checkout would take that away
    // from every contributor. The checkout goes on top, so it still wins where both answer.
    return new PackSource.Layered(
        List.of(new PackSource.Classpath(), new PackSource.Directory(checkout)));
  }

  /**
   * {@code <repo>/data/packs}, if this code is running out of a TDC source checkout.
   *
   * <p>Walking up for a bare {@code data/packs} is not enough: the name is ordinary enough that
   * an unrelated folder above an installed jar could answer, and then the same config would read
   * different data depending on where the user happened to install it. A directory only counts
   * when it ALSO holds {@code fixtures/cross-language} — the folder holding the contract all five
   * implementations are tested against, which exists in this repository and nowhere else.
   *
   * @param startFrom where to start walking up from, or {@code null} when it cannot be determined
   * @return the checkout's pack folder, or {@code null} when this is not a checkout
   */
  static Path sourceCheckoutPacks(Path startFrom) {
    for (Path current = startFrom; current != null; current = current.getParent()) {
      if (Files.isDirectory(current.resolve("fixtures").resolve("cross-language"))) {
        Path packs = current.resolve("data").resolve("packs");
        if (Files.isDirectory(packs)) {
          return packs;
        }
      }
    }
    return null;
  }

  /**
   * The folder holding this class's own code — a directory of classes in a checkout, the jar file
   * itself once published. Null when the runtime declines to say, which is not an error: it only
   * means the checkout question cannot be asked and the jar's own packs answer.
   */
  private static Path ownLocation() {
    try {
      var source = DataPacks.class.getProtectionDomain().getCodeSource();
      if (source == null) {
        return null;
      }
      Path location = Path.of(source.getLocation().toURI());
      return Files.isDirectory(location) ? location : location.getParent();
    } catch (java.net.URISyntaxException | RuntimeException e) {
      return null;
    }
  }

  /**
   * The bundled packs plus whatever {@code tdcv2.config.json} adds, searched from here upward.
   *
   * <p>A pack downloaded into a project belongs to the project, not to whichever runtime happens
   * to read it. Honouring the same config file the CLI writes is what keeps a config that uses a
   * downloaded pack working in every implementation rather than only the one that fetched it.
   */
  public static DataPacks forProject(Path cwd) {
    return forProject(cwd, List.of());
  }

  /**
   * The same, plus roots named at the call site — the command line's {@code --data-path}.
   *
   * <p>They go on last, so they shadow both the config's roots and the bundled packs. Something
   * typed for this one run should beat something written down for every run.
   */
  public static DataPacks forProject(Path cwd, List<Path> extraRoots) {
    PackSource discovered = discover();
    List<PackSource> layers = new ArrayList<>();
    layers.add(discovered);
    ProjectConfig.Resolved config = ProjectConfig.load(cwd);
    for (Path dir : config.dataPaths()) {
      if (Files.isDirectory(dir)) {
        layers.add(new PackSource.Directory(dir));
      }
    }
    // The pack store is not singled out here. Bundles unpack into it at their ADDRESS path —
    // `<store>/ru/…`, `<store>/countries/france/…` — and `pack add` writes the store itself into
    // `dataPaths` once, so it arrives above like any other root and `france.docs.nir` resolves as
    // `countries/france/docs/nir.txt`, which is where it now sits.
    for (Path root : extraRoots) {
      if (Files.isDirectory(root)) {
        layers.add(new PackSource.Directory(root));
      }
    }

    List<Path> roots = new ArrayList<>(config.dataPaths());
    roots.addAll(extraRoots);
    return layers.size() == 1
        ? new DataPacks(discovered, roots)
        : new DataPacks(new PackSource.Layered(layers), roots);
  }

  /**
   * Install a bundle from the shared registry into this project, and register it.
   *
   * <p>The one call a Java project needs to add a locale: it downloads, verifies the digest,
   * unpacks into the project's pack store, and writes the path into {@code tdcv2.config.json} so
   * the next run finds it — and so any other implementation working in the same project finds it
   * too. The registry is shared, so this is not a Java-only mechanism reimplemented; it is the
   * same catalogue, the same archives and the same store the command-line tool uses.
   *
   * @param cwd the project to install into — a directory holding, or under, its config file
   * @param bundleIds the ids to install, e.g. {@code "ru"}, {@code "usa"}, {@code "common"}
   * @return the packs, with everything just installed already resolvable
   */
  public static DataPacks install(Path cwd, String... bundleIds) {
    return install(cwd, new PackRegistry(), bundleIds);
  }

  /** The same, against a registry of the caller's choosing — a mirror, or a private one. */
  public static DataPacks install(Path cwd, PackRegistry registry, String... bundleIds) {
    Path project = cwd == null ? Path.of("").toAbsolutePath() : cwd.toAbsolutePath();
    Path configPath = ProjectConfig.findProjectConfig(project);
    Path configDir = configPath == null ? project : configPath.getParent();
    ProjectConfig.Resolved resolved = ProjectConfig.load(project);
    Path store =
        resolved.packStore() != null ? resolved.packStore() : configDir.resolve("tdcv2-packs");

    PackRegistry.Index index = registry.index();
    for (String id : bundleIds) {
      registry.install(index.find(id), store);
    }
    // One entry, whatever went in: every bundle lands in this one folder at its address path.
    ProjectConfig.register(
        configPath == null ? configDir.resolve(ProjectConfig.PROJECT_CONFIG_NAME) : configPath,
        List.of(store));
    return forProject(project);
  }

  /**
   * Resolve a dotted path against a locale and load it.
   *
   * <p>The rule the reference uses: if the first segment names a locale, a country, or a
   * reserved bucket, the path is already absolute; otherwise the active locale is prepended,
   * so {@code person.lastName} under {@code en} is {@code en/person/lastName.txt}.
   *
   * <p>This checks the first segment against the folders that actually exist, which is a
   * narrower rule than the reference's fixed lists. It agrees with them for every pack on
   * disk, and it fails loudly rather than guessing when it does not.
   */
  /**
   * Whether an address resolves, without loading it.
   *
   * <p>The validator asks this so a misspelled address is caught before the run rather than on
   * its first row.
   */
  public boolean exists(String dottedPath, String locale) {
    // A duplicate address RESOLVES — twice, which is the whole complaint, and `load` is what
    // reports it. Answering "no" here would report the collision as a misspelled address and send
    // the reader hunting for a typo that is not there.
    if (candidates(basePath(dottedPath, locale)).size() > 1) {
      return true;
    }
    try {
      load(dottedPath, locale);
      return true;
    } catch (RuntimeException e) {
      return false;
    }
  }

  /**
   * Whether a pack generator apportions a share over the whole column.
   *
   * <p>Two ways to earn it.
   *
   * <p>A {@code percent=} anywhere in a generator's body — on its {@code <mix>}, on a {@code
   * <gen>}, on a compound field — makes its quota a property of the run rather than of a row.
   *
   * <p>And a body that DRAWS from a weighted list, which the body does not say. A weighted list is
   * laid out to an exact Hamilton quota over the run, so each value takes its measured share of the
   * rows; asked for one row, that plan is computed over a column of one and the row goes to the
   * largest share, every time, for every seed. Twelve shipped full-name packs were in that state —
   * eight rows of {@code hu.person.male.fullName} were eight copies of {@code Nagy László} —
   * because the body says {@code value="hu.person.lastName"} and nothing in that line says the list
   * on the other end carries weights. German and Polish were fine, and the only difference is that
   * their name lists carry no weights.
   *
   * <p>The router asks this before sending a config to an engine that resolves one row at a time.
   *
   * <p>A plain LIST answers false even when it is weighted: the streaming engines lay a list's
   * quota out by row index without holding the column, so only a GENERATOR over one is stuck.
   */
  public boolean needsWholeColumn(String dottedPath, String locale) {
    Entry entry = load(dottedPath, locale);
    if (!entry.isGenerator()) {
      return false;
    }
    Set<String> seen = new HashSet<>();
    seen.add(cacheKey(dottedPath, locale));
    return bodyNeedsWholeColumn(entry.generator(), locale, seen);
  }

  /**
   * The same question about an address reached from inside another pack's body.
   *
   * <p>Here a weighted list IS the answer: it is the leaf the walk is looking for, and the
   * generator that drew it inherits its quota.
   *
   * @param seen the addresses already on this walk — a reference cycle is reported by the pack
   *     loader, so this stops rather than recursing for ever
   */
  private boolean drawsWholeColumn(String dottedPath, String locale, Set<String> seen) {
    if (!seen.add(cacheKey(dottedPath, locale))) {
      return false;
    }
    Entry entry;
    try {
      entry = load(dottedPath, locale);
    } catch (RuntimeException e) {
      // An address that does not resolve is the validator's problem, not this walk's.
      return false;
    }
    if (entry.weighted()) {
      return true;
    }
    return entry.isGenerator() && bodyNeedsWholeColumn(entry.generator(), locale, seen);
  }

  private boolean bodyNeedsWholeColumn(String body, String locale, Set<String> seen) {
    io.github.nickliapin.tdc.parser.ConfigBuilder.PackGenerator composed;
    try {
      composed = io.github.nickliapin.tdc.parser.ConfigBuilder.parsePackBody(body);
    } catch (RuntimeException e) {
      // A single bare <gen>: it declares a share only through its own percent=, and a bare <gen>
      // may not be a template, so it reaches no list to inherit one from.
      return body.contains("percent=");
    }
    for (io.github.nickliapin.tdc.model.Config.SequenceSpec spec : composed.sequences()) {
      if (spec.isMix() && declares(spec.mix().percent())) {
        return true;
      }
      for (io.github.nickliapin.tdc.model.Config.Gen gen : gensOf(spec)) {
        if (declares(gen.attrs().get("percent"))) {
          return true;
        }
        if (drawsWeights(gen, locale, seen)) {
          return true;
        }
      }
    }
    return false;
  }

  /** Does this {@code <gen>} inside a pack body reach a weighted list, directly or through a pack? */
  private boolean drawsWeights(
      io.github.nickliapin.tdc.model.Config.Gen gen, String locale, Set<String> seen) {
    if (!"template".equals(gen.type())) {
      return false;
    }
    String target = gen.attr("value", "");
    // `common.vehicle.model.${{Brand}}` — an address that is not known until the row is, so there
    // is no list here to ask about.
    if (target.isEmpty() || target.contains("${{")) {
      return false;
    }
    String inner = gen.attrs().get("local");
    return drawsWholeColumn(target, inner == null || inner.isBlank() ? locale : inner, seen);
  }

  /**
   * Every {@code <gen>} a pack body's sequence holds, whichever shape it took.
   *
   * <p>The compound shape is the one the full-name packs use — two NAMED gens, which is a compound
   * and not a lone {@code gen} — but a composed body keeps its gens in {@code items} instead, and a
   * conditional keeps them in {@code branches}. Reading only one of the three would have left the
   * other two silently unexamined, which is exactly how the weighted draw went unnoticed.
   */
  private static List<io.github.nickliapin.tdc.model.Config.Gen> gensOf(
      io.github.nickliapin.tdc.model.Config.SequenceSpec spec) {
    List<io.github.nickliapin.tdc.model.Config.Gen> gens = new ArrayList<>();
    if (spec.gen() != null) {
      gens.add(spec.gen());
    }
    if (spec.fields() != null) {
      for (io.github.nickliapin.tdc.model.Config.Field field : spec.fields()) {
        if (field.gen() != null) {
          gens.add(field.gen());
        }
      }
    }
    if (spec.items() != null) {
      for (io.github.nickliapin.tdc.model.Config.Item item : spec.items()) {
        if (item.gen() != null) {
          gens.add(item.gen());
        }
        if (item.field() != null && item.field().gen() != null) {
          gens.add(item.field().gen());
        }
      }
    }
    if (spec.branches() != null) {
      for (io.github.nickliapin.tdc.model.Config.Branch branch : spec.branches()) {
        if (branch.gen() != null) {
          gens.add(branch.gen());
        }
      }
    }
    return gens;
  }

  private static boolean declares(String percent) {
    return percent != null && !percent.trim().isEmpty();
  }

  /** One address as it is asked for: the same dotted path under two locales is two packs. */
  private static String cacheKey(String dottedPath, String locale) {
    return dottedPath + "|" + locale;
  }

  public Entry load(String dottedPath, String locale) {
    String key = cacheKey(dottedPath, locale);
    Entry cached = cache.get(key);
    if (cached != null) {
      return cached;
    }

    String base = basePath(dottedPath, locale);

    List<String> candidates = candidates(base);
    if (candidates.size() > 1) {
      // The extension is not part of an address, so two files that differ only by it claim the
      // SAME one. Picking the first silently would make the other dead weight its author cannot
      // see — the run keeps working and reads the same file forever.
      String firstFile = candidates.get(0);
      String secondFile = candidates.get(1);
      throw new IllegalArgumentException(
          "duplicate data-pack address \""
              + absoluteAddress(dottedPath, locale)
              + "\" declared by both \""
              + locateOr(secondFile)
              + "\" and \""
              + locateOr(firstFile)
              + "\" — rename or move one");
    }
    String file = candidates.isEmpty() ? null : candidates.get(0);

    if (file == null) {
      // The path did not answer, so ask the headers: a file may declare its own `address:` and
      // then live anywhere at all — which is how someone keeps a flat folder of their own lists.
      String placed = addresses().get(absoluteAddress(dottedPath, locale));
      if (placed == null || !source.has(placed)) {
        throw new IllegalArgumentException(
            "unknown template path \""
                + dottedPath
                + "\" (looked for "
                + base
                + ".txt in "
                + source
                + ")");
      }
      Entry placedEntry = parse(source.readLines(placed), placed);
      cache.put(key, placedEntry);
      return placedEntry;
    }

    Entry entry = parse(source.readLines(file), file);
    cache.put(key, entry);
    return entry;
  }

  /** Where this address's files sit, extension aside. */
  private String basePath(String dottedPath, String locale) {
    String first = dottedPath.split("\\.", 2)[0];
    if (source.hasTopLevel(first)) {
      // A locale or a reserved bucket: the address is already absolute.
      return dottedPath.replace('.', '/');
    }
    if (source.hasCountry(first)) {
      // A country: absolute too, but its files live under the countries/ grouping, which is
      // not part of the address anyone writes.
      return "countries/" + dottedPath.replace('.', '/');
    }
    // Relative to the active locale, so `person.lastName` under `ru` is a Russian surname.
    return (locale + "." + dottedPath).replace('.', '/');
  }

  /**
   * The files this address's path resolves to, one per extension that exists. More than one is a
   * collision, because the extension is not part of an address.
   */
  private List<String> candidates(String base) {
    List<String> found = new ArrayList<>();
    for (String extension : PACK_EXTENSIONS) {
      if (source.has(base + extension)) {
        found.add(base + extension);
      }
    }
    return found;
  }

  /** Where a file is on disk when the source can say, and its relative path when it cannot. */
  private String locateOr(String relativePath) {
    String located = source.locate(relativePath);
    return located == null ? relativePath : located;
  }

  /** The address as the index holds it: locale-prefixed unless already absolute. */
  private String absoluteAddress(String dottedPath, String locale) {
    String first = dottedPath.split("\\.", 2)[0];
    return source.hasTopLevel(first) || source.hasCountry(first)
        ? dottedPath
        : locale + "." + dottedPath;
  }

  /**
   * Every pack file's address, read from its header — built once, kept.
   *
   * <p>A header may carry {@code address:} (authoritative) and {@code locale:} (used only when the
   * path-derived address has no locale of its own). A file that resolves to neither a locale, a
   * country nor a reserved bucket is not addressable and is left out, which is the rule the
   * reference applies.
   */
  /**
   * `<sequence name="…">` in a pack generator body — the pack's parameter list.
   *
   * <p>Read by scanning rather than by parsing: the validator asks before anything is built, and
   * parsing a pack body there would report a pack author's syntax error at the caller's line.
   */
  private static final java.util.regex.Pattern SEQUENCE_NAME =
      java.util.regex.Pattern.compile("<sequence\\s+[^>]*name\\s*=\\s*\"([^\"]+)\"");

  /**
   * The parameters a generator pack accepts, or {@code null} when it is not one.
   *
   * <p>A pack's parameters ARE its local {@code <sequence>} names: writing {@code
   * domain="example.test"} on the calling {@code <gen>} replaces the sequence called {@code
   * domain} with that constant. A single-{@code <gen>} pack declares none, and a plain list of
   * values is not a generator at all — passing anything to either is always a no-op, so both
   * return an empty set rather than {@code null}.
   */
  public java.util.Set<String> parameterNames(String dottedPath, String locale) {
    Entry entry;
    try {
      entry = load(dottedPath, locale);
    } catch (RuntimeException ignored) {
      return null;
    }
    java.util.Set<String> names = new java.util.LinkedHashSet<>();
    if (entry.generator() == null) {
      // A plain list of values has no parameters at all, which is not the same as "unknown":
      // an attribute aimed at one does nothing, and an attribute that does nothing is
      // indistinguishable from a typo.
      return names;
    }
    java.util.regex.Matcher m = SEQUENCE_NAME.matcher(entry.generator());
    while (m.find()) {
      names.add(m.group(1));
    }
    return names;
  }

  /**
   * How many characters each parameter's own sequence produces, where that is a FACT.
   *
   * <p>A pinned parameter replaces the pack's own sequence for the run, and the packs that carry
   * a check digit compute it over a fixed layout — see {@link ParamWidth} for what counts as
   * provable.
   */
  public java.util.Map<String, Integer> parameterWidths(String dottedPath, String locale) {
    Entry entry;
    try {
      entry = load(dottedPath, locale);
    } catch (RuntimeException ignored) {
      return java.util.Map.of();
    }
    return entry.generator() == null
        ? java.util.Map.of()
        : ParamWidth.parameterWidths(entry.generator());
  }

  /**
   * Every address these packs can answer to, in no particular order.
   *
   * <p>The quick API needs the whole list rather than a yes-or-no about one address: to say "did
   * you mean" it has to compare what was typed against all of them. Building the index is the cost
   * of the first call only.
   */
  public java.util.Set<String> addressList() {
    return java.util.Set.copyOf(addresses().keySet());
  }

  private Map<String, String> addresses() {
    if (addressIndex != null) {
      return addressIndex;
    }
    Map<String, String> index = new HashMap<>();
    List<Diagnostic> dropped = new ArrayList<>();
    for (String file : source.listFiles()) {
      List<String> lines = source.readLines(file);
      Map<String, String> header = headerOf(lines);
      String declared = header.get("address");
      String address;
      if (declared != null && !declared.isBlank()) {
        address = declared.trim();
      } else {
        String derived = stripExtension(file).replace('/', '.');
        if (derived.startsWith("countries.")) {
          derived = derived.substring("countries.".length());
        }
        String head = derived.split("\\.", 2)[0];
        if (source.hasTopLevel(head) || source.hasCountry(head)) {
          address = derived;
        } else {
          // Not under a locale folder: the header's own `locale:` is the only thing that can say
          // where this belongs.
          String declaredLocale = header.get("locale");
          if (declaredLocale == null || declaredLocale.isBlank()) {
            if (hasHeader(lines)) {
              String where = source.locate(file);
              dropped.add(unaddressableWarning(where == null ? file : where, derived));
            }
            continue;
          }
          address = declaredLocale.trim() + "." + derived;
        }
      }
      index.put(address, file);
    }
    addressIndex = index;
    unaddressable = List.copyOf(dropped);
    return index;
  }

  /**
   * Every pack file the address scan read and could not place — TDC171.
   *
   * <p>Empty until something has looked an address up and missed, because that is when the scan
   * runs. The reference walks every pack root before it starts and can therefore say this about a
   * file no config mentions; here the walk is the fallback path, and a run that resolves
   * everything by path never pays for it. The author who wrote the unplaceable file always takes
   * the fallback — their own address is the one that misses — so the file gets named at the
   * moment it matters. {@code fixtures/cross-language/cli.json} records the difference.
   */
  public List<Diagnostic> headerWarnings() {
    return unaddressable;
  }

  /**
   * A pack file the scan read and could not address.
   *
   * <p>A warning rather than an error: the run continues on everything else, and the author hears
   * about the file instead of meeting it later as "unknown template path" with nothing to connect
   * the two.
   */
  private static Diagnostic unaddressableWarning(String file, String address) {
    return Diagnostic.warning(
        "TDC171",
        "data-pack file \"" + file + "\" is not addressable: \"" + address
            + "\" starts with no locale, country or `common`. Add `address:` or `locale:` to its "
            + "header, or move it under a locale folder.",
        "Data pack file: " + file,
        1,
        0);
  }

  /**
   * Whether the file opens with the {@code ---} fence.
   *
   * <p>A file with no header at all stays silent when it cannot be placed: it is probably a raw
   * {@code @data} source that happens to sit in a pack folder, not a pack somebody meant to
   * publish.
   */
  private static boolean hasHeader(List<String> lines) {
    return !lines.isEmpty() && "---".equals(lines.get(0).trim());
  }

  /** Just the {@code ---} fenced header, for the address scan: no body, no validation. */
  private static Map<String, String> headerOf(List<String> lines) {
    Map<String, String> header = new HashMap<>();
    if (lines.isEmpty() || !"---".equals(lines.get(0).trim())) {
      return header;
    }
    for (int i = 1; i < lines.size(); i++) {
      String line = lines.get(i).trim();
      if ("---".equals(line)) {
        break;
      }
      if (line.isEmpty() || line.startsWith("#")) {
        continue;
      }
      int colon = line.indexOf(':');
      if (colon > 0) {
        header.put(
            line.substring(0, colon).trim().toLowerCase(java.util.Locale.ROOT),
            line.substring(colon + 1).trim());
      }
    }
    return header;
  }

  private static Entry parse(List<String> lines, String file) {
    Map<String, String> header = new HashMap<>();
    int start = 0;
    if (!lines.isEmpty() && "---".equals(lines.get(0).trim())) {
      int end = 1;
      while (end < lines.size() && !"---".equals(lines.get(end).trim())) {
        String line = lines.get(end);
        int colon = line.indexOf(':');
        if (colon > 0) {
          header.put(line.substring(0, colon).trim(), line.substring(colon + 1).trim());
        }
        end++;
      }
      start = end + 1;
    }

    List<String> body = new ArrayList<>();
    for (int i = start; i < lines.size(); i++) {
      String line = lines.get(i);
      if (!line.isBlank()) {
        body.add(line);
      }
    }

    // `generator: tdc` marks a pack whose body is a <gen> tag rather than a list of values.
    // Some things cannot be listed — a UUID, an account number — so the pack ships the rule.
    if ("tdc".equals(header.get("generator"))) {
      return new Entry(List.of(), null, String.join("\n", body));
    }

    if (!"true".equals(header.get("weighted"))) {
      return new Entry(List.copyOf(body), null, null);
    }

    String delimiter = header.getOrDefault("delimiter", ",");
    List<String> values = new ArrayList<>(body.size());
    List<Double> counts = new ArrayList<>(body.size());
    double total = 0;
    for (String line : body) {
      int at = line.lastIndexOf(delimiter);
      if (at < 0) {
        throw new IllegalArgumentException(
            "weighted pack " + file + ": line \"" + line + "\" has no count");
      }
      double weight = Double.parseDouble(line.substring(at + delimiter.length()).trim());
      // A zero weight means "never drawn". Dropping it rather than carrying it at zero
      // probability is what the reference does, and census files are full of them.
      if (weight == 0) {
        continue;
      }
      values.add(line.substring(0, at));
      counts.add(weight);
      total += weight;
    }
    if (values.isEmpty()) {
      throw new IllegalArgumentException("weighted pack " + file + " has no positive counts");
    }

    double[] percents = new double[counts.size()];
    for (int i = 0; i < counts.size(); i++) {
      // Written exactly as the reference computes it. Reordering these operations changes
      // the last bits of the double, which changes a Hamilton remainder, which changes which
      // row gets a leftover — and the output stops matching.
      percents[i] = (counts.get(i) / total) * 100;
    }
    return new Entry(List.copyOf(values), percents, null);
  }
}
