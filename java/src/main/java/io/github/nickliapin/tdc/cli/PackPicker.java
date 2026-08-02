package io.github.nickliapin.tdc.cli;

import io.github.nickliapin.tdc.packs.PackRegistry;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The interactive picker behind {@code tdcv2 pack}.
 *
 * <p>The catalogue is 108 bundles and growing. As one flat list it is unusable: a screenful at a
 * time, languages interleaved with countries, and finding Brazil means paging through the
 * alphabet. So it is browsed the way the catalogue is actually shaped — the locale-agnostic set,
 * then languages, then countries reached through a continent — with search from anywhere and a
 * basket reviewed before anything downloads.
 *
 * <p>The map is not decoration. The continent under the cursor lights up, and every pick burns a
 * spark where that country actually is, so "what have I taken so far" is answerable at a glance.
 * Where a country sits comes from the registry index, not from a table kept here.
 *
 * <p><b>Raw input.</b> Java has no API for putting a terminal into raw mode, so this shells out to
 * {@code stty}, which exists on macOS, Linux and the BSDs and does not on Windows. On Windows the
 * picker declines to open and {@code pack} prints its list instead — a working command everywhere
 * beats a broken screen somewhere.
 *
 * <p>This class draws and returns a decision. It never touches the network or the disk: the caller
 * installs and removes, so digests, progress and config writing keep one home.
 */
final class PackPicker {

  /** What the user chose. A null decision means they left without confirming. */
  record Decision(List<String> install, List<String> remove) {}

  private record Continent(String key, String name, int colour, int bright) {}

  private static final List<Continent> CONTINENTS =
      List.of(
          new Continent("europe", "Europe", 34, 94),
          new Continent("asia", "Asia", 35, 95),
          new Continent("africa", "Africa", 33, 93),
          new Continent("north", "North America", 36, 96),
          new Continent("south", "South America", 32, 92),
          new Continent("oceania", "Oceania", 31, 91));

  /**
   * The continents as rough outlines in real coordinates rather than a fixed grid of characters.
   *
   * <p>A hand-drawn grid only looks right at the size it was drawn for. Polygons are rasterised to
   * whatever the window allows, so the shapes survive being made bigger — and each landmass's
   * coastline falls out of the same data, which is what lets the map be drawn as outlines.
   */
  private static final Map<String, double[][][]> OUTLINES = outlines();

  private static Map<String, double[][][]> outlines() {
    Map<String, double[][][]> out = new HashMap<>();
    out.put("africa", new double[][][] {
      {{-17, 15}, {-16, 12}, {-13, 8}, {-7, 4}, {3, 6}, {9, 4}, {9, -1}, {12, -6}, {13, -13},
       {15, -22}, {18, -34}, {25, -34}, {32, -26}, {40, -16}, {41, -2}, {51, 12}, {43, 12},
       {37, 22}, {34, 28}, {32, 31}, {20, 32}, {10, 34}, {0, 36}, {-6, 36}, {-10, 30}, {-16, 22}},
      {{44, -12}, {50, -15}, {50, -25}, {45, -25}, {43, -16}},
    });
    out.put("europe", new double[][][] {
      {{-10, 36}, {-9, 43}, {-2, 48}, {-5, 50}, {-6, 58}, {5, 62}, {12, 68}, {28, 71}, {40, 66},
       {60, 66}, {60, 50}, {50, 46}, {40, 44}, {28, 41}, {24, 36}, {15, 38}, {12, 45}, {3, 43}},
    });
    out.put("asia", new double[][][] {
      {{60, 66}, {70, 73}, {100, 77}, {140, 73}, {170, 68}, {180, 65}, {180, 60}, {160, 60},
       {155, 50}, {142, 45}, {130, 35}, {122, 30}, {110, 20}, {105, 10}, {100, 2}, {95, 15},
       {88, 21}, {80, 8}, {72, 20}, {62, 25}, {56, 26}, {52, 17}, {43, 12}, {35, 30}, {36, 36},
       {28, 41}, {40, 44}, {50, 46}, {60, 50}},
    });
    out.put("north", new double[][][] {
      {{-168, 66}, {-165, 60}, {-152, 58}, {-140, 60}, {-130, 54}, {-125, 48}, {-124, 40},
       {-117, 32}, {-110, 23}, {-105, 20}, {-97, 16}, {-92, 15}, {-84, 10}, {-78, 8}, {-83, 15},
       {-88, 21}, {-97, 26}, {-94, 29}, {-89, 29}, {-82, 25}, {-81, 32}, {-76, 37}, {-70, 43},
       {-66, 45}, {-60, 47}, {-55, 52}, {-64, 60}, {-78, 62}, {-95, 60}, {-85, 68}, {-100, 70},
       {-125, 70}, {-140, 70}, {-160, 71}},
      {{-45, 60}, {-20, 70}, {-20, 82}, {-60, 83}, {-70, 76}, {-55, 64}},
    });
    out.put("south", new double[][][] {
      {{-81, 8}, {-77, 1}, {-80, -5}, {-71, -18}, {-70, -25}, {-72, -40}, {-75, -52}, {-68, -55},
       {-65, -42}, {-62, -38}, {-57, -35}, {-48, -25}, {-40, -20}, {-35, -8}, {-44, -2}, {-50, 0},
       {-60, 6}, {-70, 11}, {-77, 8}},
    });
    out.put("oceania", new double[][][] {
      {{114, -22}, {113, -26}, {115, -34}, {129, -32}, {138, -35}, {147, -38}, {150, -37},
       {153, -28}, {146, -19}, {142, -11}, {136, -12}, {130, -11}, {125, -14}, {122, -18}},
      {{172, -34}, {174, -37}, {178, -38}, {174, -41}, {171, -44}, {167, -46}, {166, -45},
       {170, -41}},
    });
    return Map.copyOf(out);
  }

  private static final double LON_MIN = -170;
  private static final double LON_MAX = 190;
  private static final double LAT_MAX = 84;
  private static final double LAT_MIN = -56;

  private static final String ESC = "[";

  private final boolean unicode = detectUnicode();
  private final boolean colour = detectColour();
  private final Map<String, String> glyphs = glyphs();

  private final List<PackRegistry.Bundle> bundles;
  private final Map<String, PackRegistry.Bundle> byId = new HashMap<>();
  private final Set<String> installed;
  private final List<PackRegistry.Bundle> languages = new ArrayList<>();
  private final List<PackRegistry.Bundle> countries = new ArrayList<>();
  private final List<PackRegistry.Bundle> neither = new ArrayList<>();

  private final Set<String> selected = new LinkedHashSet<>();
  private final Set<String> dropping = new LinkedHashSet<>();
  private final List<Screen> stack = new ArrayList<>();
  private String query = "";
  private String flash = "";
  private boolean bodyVisible;

  private static final class Screen {
    final String screen;
    int cursor;
    int offset;

    Screen(String screen) {
      this.screen = screen;
    }
  }

  private record Item(String kind, String label, String hint, String id, String to, String act,
      String region) {
    static Item pack(String id, String label, String hint) {
      return new Item("pack", label, hint, id, null, null, null);
    }

    static Item group(String to, String label, String hint, String region) {
      return new Item("group", label, hint, null, to, null, region);
    }

    static Item action(String act, String label, String hint) {
      return new Item("action", label, hint, null, null, act, null);
    }
  }

  private PackPicker(List<PackRegistry.Bundle> bundles, Set<String> installed) {
    this.bundles = bundles;
    this.installed = installed;
    for (PackRegistry.Bundle b : bundles) {
      byId.put(b.id(), b);
      if (b.locale() != null) {
        languages.add(b);
      } else if (b.country() != null) {
        countries.add(b);
      } else {
        neither.add(b);
      }
    }
    stack.add(new Screen("start"));
  }

  /**
   * Whether this terminal can host the picker at all.
   *
   * <p>{@code TDCV2_NO_PICKER} turns it off deliberately: for a script that wants the printed
   * list, for anyone who would rather not be dropped into a full-screen program, and for seeing
   * what Windows sees without being on Windows.
   */
  static boolean available() {
    return System.getenv("TDCV2_NO_PICKER") == null
        && System.console() != null
        && !System.getProperty("os.name", "").startsWith("Windows");
  }

  /** Browse the catalogue and come back with what to install and what to remove. */
  static Decision run(List<PackRegistry.Bundle> bundles, Set<String> installed) {
    PackPicker picker = new PackPicker(bundles, installed);
    String saved = Stty.enterRaw();
    try {
      picker.write(ESC + "?25l");
      return picker.loop();
    } finally {
      picker.write(ESC + "?25h" + ESC + "2J" + ESC + "H");
      Stty.restore(saved);
    }
  }

  // ── terminal capabilities ──

  private static boolean detectUnicode() {
    if (System.getenv("TDCV2_ASCII") != null) {
      return false;
    }
    String locale = System.getenv("LC_ALL");
    if (locale == null) {
      locale = System.getenv("LC_CTYPE");
    }
    if (locale == null) {
      locale = System.getenv("LANG");
    }
    return locale == null || locale.toLowerCase(Locale.ROOT).replace("-", "").contains("utf8");
  }

  private static boolean detectColour() {
    return System.getenv("NO_COLOR") == null && !"dumb".equals(System.getenv("TERM"));
  }

  private Map<String, String> glyphs() {
    Map<String, String> g = new HashMap<>();
    boolean u = unicode;
    g.put("cursor", u ? "❯" : ">");
    g.put("group", u ? "»" : ">");
    g.put("on", u ? "▣" : "[x]");
    g.put("off", u ? "▢" : "[ ]");
    g.put("done", u ? "✓" : "[+]");
    g.put("drop", u ? "✗" : "[-]");
    g.put("chip", u ? "■" : "*");
    g.put("land", u ? "█" : "#");
    return g;
  }

  private String sgr(String text, String code) {
    return colour ? ESC + code + "m" + text + ESC + "0m" : text;
  }

  private String dim(String text) {
    return sgr(text, "2");
  }

  private String bold(String text) {
    return sgr(text, "1");
  }

  private void write(String text) {
    System.out.print(text);
    System.out.flush();
  }

  // ── the map ──

  private static boolean inside(double lon, double lat, double[][] ring) {
    boolean hit = false;
    for (int i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      double xi = ring[i][0];
      double yi = ring[i][1];
      double xj = ring[j][0];
      double yj = ring[j][1];
      if (yi > lat != yj > lat && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        hit = !hit;
      }
    }
    return hit;
  }

  private record Raster(int w, int h, String[] land, boolean[] edge) {}

  private final Map<String, Raster> rasters = new HashMap<>();

  private Raster raster(int w, int h) {
    Raster cached = rasters.get(w + "x" + h);
    if (cached != null) {
      return cached;
    }
    String[] land = new String[w * h];
    for (int row = 0; row < h; row++) {
      double lat = LAT_MAX - ((row + 0.5) / h) * (LAT_MAX - LAT_MIN);
      for (int col = 0; col < w; col++) {
        double lon = LON_MIN + ((col + 0.5) / w) * (LON_MAX - LON_MIN);
        for (Map.Entry<String, double[][][]> entry : OUTLINES.entrySet()) {
          boolean hit = false;
          for (double[][] ring : entry.getValue()) {
            if (inside(lon, lat, ring) || inside(lon - 360, lat, ring)) {
              hit = true;
              break;
            }
          }
          if (hit) {
            land[row * w + col] = entry.getKey();
            break;
          }
        }
      }
    }
    boolean[] edge = new boolean[w * h];
    for (int row = 0; row < h; row++) {
      for (int col = 0; col < w; col++) {
        String here = land[row * w + col];
        if (here == null) {
          continue;
        }
        edge[row * w + col] =
            row == 0 || row == h - 1 || col == 0 || col == w - 1
                || !here.equals(land[(row - 1) * w + col])
                || !here.equals(land[(row + 1) * w + col])
                || !here.equals(land[row * w + col - 1])
                || !here.equals(land[row * w + col + 1]);
      }
    }
    Raster built = new Raster(w, h, land, edge);
    rasters.put(w + "x" + h, built);
    return built;
  }

  /** The largest map that still leaves room for the list, or null when nothing sensible fits. */
  private int[] mapSize(int columns, int rows, int reserved) {
    for (int w = Math.min(columns - 4, 132); w >= 56; w -= 4) {
      // 360 degrees of longitude against 140 of latitude: keep the ratio so nothing is squashed.
      int h = Math.max(2, (int) Math.round(w * 0.39 / 2) * 2);
      if ((unicode && colour ? h / 2 : h) + reserved <= rows) {
        return new int[] {w, h};
      }
    }
    return null;
  }

  private Map<String, Integer> counts() {
    Map<String, Integer> out = new HashMap<>();
    for (Continent c : CONTINENTS) {
      int n = 0;
      for (PackRegistry.Bundle b : inRegion(c.key())) {
        if (selected.contains(b.id())) {
          n++;
        }
      }
      out.put(c.key(), n);
    }
    return out;
  }

  private String shade(Raster r, int index, String focused, Set<Integer> lit,
      Map<String, Integer> counts) {
    // Land you have not chosen is a grey body under a coloured coastline: the shape stays
    // readable, but nothing is filled in until you pick it.
    if (lit.contains(index)) {
      return "1;97";
    }
    String key = r.land()[index];
    if (key == null) {
      return null;
    }
    Continent continent = null;
    for (Continent c : CONTINENTS) {
      if (c.key().equals(key)) {
        continent = c;
      }
    }
    if (continent == null) {
      return null;
    }
    boolean isEdge = r.edge()[index];
    if (key.equals(focused)) {
      return isEdge ? "1;" + continent.bright() : String.valueOf(continent.colour());
    }
    if (counts.getOrDefault(key, 0) > 0) {
      return isEdge ? String.valueOf(continent.bright()) : "2;" + continent.colour();
    }
    if (isEdge) {
      return String.valueOf(continent.colour());
    }
    return bodyVisible ? "90" : null;
  }

  private List<String> renderMap(int w, int h, String focused, int columns) {
    Raster r = raster(w, h);
    Map<String, Integer> counts = counts();
    Set<Integer> lit = new java.util.HashSet<>();
    for (String id : selected) {
      PackRegistry.Bundle b = byId.get(id);
      if (b == null || b.point() == null) {
        continue;
      }
      int col = (int) Math.round((b.point()[0] - LON_MIN) / (LON_MAX - LON_MIN) * w - 0.5);
      int row = (int) Math.round((LAT_MAX - b.point()[1]) / (LAT_MAX - LAT_MIN) * h - 0.5);
      if (col >= 0 && col < w && row >= 0 && row < h) {
        lit.add(row * w + col);
      }
    }

    List<String> lines = new ArrayList<>();
    if (unicode && colour) {
      for (int row = 0; row < h; row += 2) {
        StringBuilder line = new StringBuilder("  ");
        for (int col = 0; col < w; col++) {
          String upper = shade(r, row * w + col, focused, lit, counts);
          String lower = row + 1 < h ? shade(r, (row + 1) * w + col, focused, lit, counts) : null;
          if (upper == null && lower == null) {
            line.append(' ');
          } else if (upper != null && lower != null) {
            // One cell, two pixels: the top is drawn, the bottom becomes its background.
            String[] parts = lower.split(";");
            int background = Integer.parseInt(parts[parts.length - 1]) + 10;
            line.append(ESC).append(upper).append(';').append(background).append("m▀")
                .append(ESC).append("0m");
          } else if (upper != null) {
            line.append(ESC).append(upper).append("m▀").append(ESC).append("0m");
          } else {
            line.append(ESC).append(lower).append("m▄").append(ESC).append("0m");
          }
        }
        lines.add(line.toString());
      }
    } else {
      // No half-blocks, or no colour to tell the two pixels apart: one row per line, coastlines
      // only. Still a world, and it still shows where a pick landed.
      for (int row = 0; row < h; row++) {
        StringBuilder line = new StringBuilder("  ");
        for (int col = 0; col < w; col++) {
          int index = row * w + col;
          String code = shade(r, index, focused, lit, counts);
          if (code == null || (!colour && !r.edge()[index] && !lit.contains(index))) {
            line.append(' ');
          } else if (colour) {
            line.append(ESC).append(code).append('m').append(glyphs.get("land")).append(ESC)
                .append("0m");
          } else {
            line.append(glyphs.get("land"));
          }
        }
        lines.add(line.toString());
      }
    }

    List<String> chips = new ArrayList<>();
    for (Continent c : CONTINENTS) {
      int picked = counts.getOrDefault(c.key(), 0);
      String label = picked > 0 ? c.name() + " (" + picked + ")" : c.name();
      chips.add(sgr(glyphs.get("chip") + " " + label,
          c.key().equals(focused) ? "1;" + c.bright() : "2;" + c.colour()));
    }
    lines.add("");
    if (columns >= 92) {
      lines.add("  " + String.join("   ", chips));
    } else {
      lines.add("  " + String.join("   ", chips.subList(0, 3)));
      lines.add("  " + String.join("   ", chips.subList(3, chips.size())));
    }
    return lines;
  }

  // ── screens ──

  private Screen top() {
    return stack.get(stack.size() - 1);
  }

  private List<PackRegistry.Bundle> inRegion(String key) {
    List<PackRegistry.Bundle> out = new ArrayList<>();
    for (PackRegistry.Bundle b : countries) {
      if (b.regions().contains(key)) {
        out.add(b);
      }
    }
    return out;
  }

  private List<String> notInstalled() {
    List<String> out = new ArrayList<>();
    for (PackRegistry.Bundle b : bundles) {
      if (!installed.contains(b.id())) {
        out.add(b.id());
      }
    }
    return out;
  }

  private static String humanSize(long bytes) {
    return bytes < 102_400
        ? Math.round(bytes / 1024.0) + " KB"
        : String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0);
  }

  private String sizeOf(String id) {
    PackRegistry.Bundle b = byId.get(id);
    return b == null ? "" : humanSize(b.bytes());
  }

  /** "Argentina (country)" is right in a printed list, and noise on a screen that says so. */
  private static String plainName(String name) {
    for (String suffix : new String[] {" (country)", " (language)", " (locale-agnostic)"}) {
      if (name.endsWith(suffix)) {
        return name.substring(0, name.length() - suffix.length());
      }
    }
    return name;
  }

  private int pickedIn(List<PackRegistry.Bundle> list) {
    int n = 0;
    for (PackRegistry.Bundle b : list) {
      if (selected.contains(b.id())) {
        n++;
      }
    }
    return n;
  }

  private List<Item> items() {
    String screen = top().screen;
    List<Item> out = new ArrayList<>();
    switch (screen) {
      case "start" -> {
        List<String> rest = notInstalled();
        long total = 0;
        for (String id : rest) {
          total += byId.get(id).bytes();
        }
        out.add(Item.action("all", "Everything",
            rest.isEmpty() ? "already installed"
                : rest.size() + " not installed · " + humanSize(total)));
        out.add(Item.group("browse", "Choose what I need", "by language, by country, or search",
            null));
        if (!installed.isEmpty()) {
          out.add(Item.group("installed", "Installed packs",
              installed.size() + " here · remove any you no longer want", null));
        }
      }
      case "browse" -> {
        for (PackRegistry.Bundle b : neither) {
          String note = b.description();
          out.add(Item.pack(b.id(), plainName(b.name()),
              note.length() > 64 ? note.substring(0, 64) : note));
        }
        int pl = pickedIn(languages);
        int pc = pickedIn(countries);
        out.add(Item.group("languages", "Languages",
            languages.size() + " available" + (pl > 0 ? " · " + pl + " picked" : ""), null));
        out.add(Item.group("regions", "Countries",
            countries.size() + " available" + (pc > 0 ? " · " + pc + " picked" : ""), null));
        out.add(Item.group("review", "Review and install",
            selected.isEmpty() ? "basket is empty" : selected.size() + " in the basket", null));
      }
      case "languages" -> {
        for (PackRegistry.Bundle b : languages) {
          out.add(Item.pack(b.id(), plainName(b.name()), b.id() + " · " + sizeOf(b.id())));
        }
      }
      case "regions" -> {
        for (Continent c : CONTINENTS) {
          List<PackRegistry.Bundle> here = inRegion(c.key());
          int picked = pickedIn(here);
          out.add(Item.group("region:" + c.key(), c.name(),
              here.size() + " countries" + (picked > 0 ? " · " + picked + " picked" : ""),
              c.key()));
        }
      }
      case "installed" -> {
        for (String id : new TreeSet<>(installed)) {
          PackRegistry.Bundle b = byId.get(id);
          out.add(Item.pack(id, plainName(b == null ? id : b.name()),
              dropping.contains(id) ? "marked for removal" : id + " · installed"));
        }
      }
      case "review" -> {
        List<String> chosen = new ArrayList<>(new TreeSet<>(selected));
        if (chosen.isEmpty() && dropping.isEmpty()) {
          return out;
        }
        long total = 0;
        for (String id : chosen) {
          PackRegistry.Bundle b = byId.get(id);
          total += b == null ? 0 : b.bytes();
          out.add(Item.pack(id, plainName(b == null ? id : b.name()),
              id + " · " + sizeOf(id)));
        }
        for (String id : new TreeSet<>(dropping)) {
          PackRegistry.Bundle b = byId.get(id);
          out.add(Item.pack(id, plainName(b == null ? id : b.name()), "will be removed"));
        }
        List<String> what = new ArrayList<>();
        if (!chosen.isEmpty()) {
          what.add("install " + chosen.size());
        }
        if (!dropping.isEmpty()) {
          what.add("remove " + dropping.size());
        }
        out.add(Item.action("confirm", "Apply — " + String.join(", ", what),
            chosen.isEmpty() ? "" : humanSize(total)));
      }
      case "search" -> {
        String q = query.trim().toLowerCase(Locale.ROOT);
        if (q.isEmpty()) {
          return out;
        }
        for (PackRegistry.Bundle b : bundles) {
          if (!b.id().contains(q) && !plainName(b.name()).toLowerCase(Locale.ROOT).contains(q)) {
            continue;
          }
          String where;
          if (b.locale() != null) {
            where = "language";
          } else if (b.country() != null) {
            List<String> names = new ArrayList<>();
            for (Continent c : CONTINENTS) {
              if (b.regions().contains(c.key())) {
                names.add(c.name());
              }
            }
            where = String.join(" / ", names);
          } else {
            where = "no language, no country";
          }
          out.add(Item.pack(b.id(), plainName(b.name()), where + " · " + sizeOf(b.id())));
        }
      }
      default -> {
        for (PackRegistry.Bundle b : inRegion(screen.substring("region:".length()))) {
          out.add(Item.pack(b.id(), plainName(b.name()),
              b.id() + " · " + sizeOf(b.id())
                  + (b.regions().size() > 1 ? " · spans two continents" : "")));
        }
      }
    }
    return out;
  }

  private String title() {
    String screen = top().screen;
    return switch (screen) {
      case "start" -> "Data packs";
      case "browse" -> "Data packs › Choose";
      case "languages" -> "Data packs › Languages";
      case "regions" -> "Data packs › Countries";
      case "installed" -> "Data packs › Installed";
      case "review" -> "Data packs › Review";
      case "search" -> "Data packs › Search";
      default -> {
        String key = screen.substring("region:".length());
        String name = key;
        for (Continent c : CONTINENTS) {
          if (c.key().equals(key)) {
            name = c.name();
          }
        }
        yield "Data packs › Countries › " + name;
      }
    };
  }

  // ── drawing ──

  private void draw() {
    Screen state = top();
    List<Item> items = items();
    int[] window = Stty.size();
    int columns = window[0];
    int rows = window[1];

    boolean onMap = state.screen.equals("regions") || state.screen.startsWith("region:");
    int[] size = onMap ? mapSize(columns, rows, 13) : null;
    int chrome = size == null ? 8 : (unicode && colour ? size[1] / 2 : size[1]) + 13;
    int viewport = Math.max(4, Math.min(items.size(), rows - chrome));

    // An empty list still has to draw. Clamping only the upper end let the cursor reach -1 on a
    // screen with nothing in it, and the row loop then started below zero.
    state.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, items.size() - 1));
    if (state.cursor < state.offset) {
      state.offset = state.cursor;
    }
    if (state.cursor >= state.offset + viewport) {
      state.offset = state.cursor - viewport + 1;
    }
    state.offset = Math.max(0, state.offset);

    StringBuilder out = new StringBuilder(ESC + "2J" + ESC + "H");
    out.append("\n\n").append("  ").append(bold(title())).append("\n\n");

    if (size != null) {
      String focused = state.screen.startsWith("region:")
          ? state.screen.substring("region:".length())
          : (items.isEmpty() ? null : items.get(state.cursor).region());
      for (String line : renderMap(size[0], size[1], focused, columns)) {
        out.append(line).append('\n');
      }
      out.append('\n');
    }

    if (state.screen.equals("search")) {
      out.append("  Search: ")
          .append(query.isEmpty() ? dim("type a name…") : bold(query))
          .append("\n\n");
    }

    if (items.isEmpty()) {
      out.append(dim(switch (state.screen) {
        case "search" -> "  nothing matches";
        case "review" -> "  Nothing picked yet — go back and choose something.";
        default -> "  empty";
      })).append('\n');
    }

    for (int i = state.offset; i < Math.min(items.size(), state.offset + viewport); i++) {
      Item item = items.get(i);
      boolean here = i == state.cursor;
      String mark = "   ";
      if (item.kind().equals("pack") && item.id() != null) {
        if (dropping.contains(item.id())) {
          mark = bold(" " + glyphs.get("drop") + " ");
        } else if (selected.contains(item.id())) {
          mark = bold(" " + glyphs.get("on") + " ");
        } else if (installed.contains(item.id())) {
          mark = dim(" " + glyphs.get("done") + " ");
        } else {
          mark = " " + glyphs.get("off") + " ";
        }
      } else if (item.kind().equals("group")) {
        mark = " " + glyphs.get("group") + " ";
      }
      String label = String.format(Locale.ROOT, "%-26s", item.label());
      out.append("  ").append(here ? bold(glyphs.get("cursor")) : " ").append(mark)
          .append(here ? bold(label) : label).append(' ').append(dim(item.hint())).append('\n');
    }

    if (items.size() > viewport) {
      out.append('\n').append(dim("  " + (state.offset + 1) + "–"
          + Math.min(items.size(), state.offset + viewport) + " of " + items.size())).append('\n');
    }

    out.append('\n');
    out.append(dim("  " + switch (state.screen) {
      case "search" -> "↑↓ move · enter pick · esc leave search";
      case "review" ->
          "↑↓ move · space drop · enter apply · backspace back · q cancel";
      case "installed" ->
          "↑↓ move · space mark for removal · backspace back · q cancel";
      default ->
          "↑↓ move · enter open · space pick · / search · m map"
              + " · backspace back · q cancel";
    })).append('\n');

    if (!selected.isEmpty() || !dropping.isEmpty()) {
      List<String> parts = new ArrayList<>();
      if (!selected.isEmpty()) {
        parts.add(selected.size() + " to install");
      }
      if (!dropping.isEmpty()) {
        parts.add(dropping.size() + " to remove");
      }
      out.append("  ").append(dim("basket: ")).append(bold(String.join(", ", parts))).append('\n');
    }
    if (!flash.isEmpty()) {
      out.append('\n').append("  ").append(flash).append('\n');
    }

    write(out.toString());
  }

  // ── keys ──

  private void toggle(String id) {
    if (top().screen.equals("installed") || dropping.contains(id)) {
      if (!dropping.remove(id)) {
        dropping.add(id);
      }
      return;
    }
    if (installed.contains(id)) {
      flash = dim(id + " is already installed");
      return;
    }
    if (!selected.remove(id)) {
      selected.add(id);
    }
  }

  private Decision loop() {
    InputStream in = System.in;
    while (true) {
      draw();
      String key = Keys.read(in);
      Screen state = top();
      List<Item> items = items();
      flash = "";

      if (key.equals("quit") || key.equals("q")) {
        return null;
      }

      if (state.screen.equals("search")) {
        switch (key) {
          case "escape" -> {
            stack.remove(stack.size() - 1);
            query = "";
            continue;
          }
          case "backspace" -> {
            query = query.isEmpty() ? query : query.substring(0, query.length() - 1);
            state.cursor = 0;
            continue;
          }
          case "space" -> {
            query += " ";
            state.cursor = 0;
            continue;
          }
          case "enter" -> {
            if (!items.isEmpty() && items.get(state.cursor).id() != null) {
              toggle(items.get(state.cursor).id());
            }
            continue;
          }
          default -> {
            if (key.length() == 1 && key.charAt(0) >= ' ') {
              query += key;
              state.cursor = 0;
              continue;
            }
          }
        }
      }

      switch (key) {
        case "up" -> state.cursor = Math.max(0, state.cursor - 1);
        case "down" -> state.cursor = Math.max(0, Math.min(items.size() - 1, state.cursor + 1));
        case "pageup" -> state.cursor = Math.max(0, state.cursor - 10);
        case "pagedown" -> state.cursor = Math.max(0, Math.min(items.size() - 1, state.cursor + 10));
        case "home" -> state.cursor = 0;
        case "end" -> state.cursor = Math.max(0, items.size() - 1);
        case "m" -> {
          bodyVisible = !bodyVisible;
          flash = dim(bodyVisible ? "land filled" : "coastlines only");
        }
        case "/" -> {
          stack.add(new Screen("search"));
          query = "";
        }
        case "space" -> {
          Item item = items.isEmpty() ? null : items.get(state.cursor);
          if (item != null && item.kind().equals("pack") && item.id() != null) {
            toggle(item.id());
          } else if (item != null && item.to() != null && item.to().startsWith("region:")) {
            // Space on a continent takes the whole continent — "all of Africa" in one key.
            List<PackRegistry.Bundle> here = new ArrayList<>();
            for (PackRegistry.Bundle b : inRegion(item.to().substring("region:".length()))) {
              if (!installed.contains(b.id())) {
                here.add(b);
              }
            }
            boolean everything = true;
            for (PackRegistry.Bundle b : here) {
              everything &= selected.contains(b.id());
            }
            for (PackRegistry.Bundle b : here) {
              if (everything) {
                selected.remove(b.id());
              } else {
                selected.add(b.id());
              }
            }
            flash = dim(everything ? "continent cleared" : "whole continent added");
          }
        }
        case "enter" -> {
          Item item = items.isEmpty() ? null : items.get(state.cursor);
          if (item == null) {
            break;
          }
          if (item.kind().equals("group")) {
            stack.add(new Screen(item.to()));
          } else if ("all".equals(item.act())) {
            selected.addAll(notInstalled());
            stack.add(new Screen("review"));
          } else if ("confirm".equals(item.act())) {
            return new Decision(new ArrayList<>(new TreeSet<>(selected)),
                new ArrayList<>(new TreeSet<>(dropping)));
          }
        }
        case "backspace", "escape", "left" -> {
          if (stack.size() > 1) {
            stack.remove(stack.size() - 1);
          }
        }
        default -> { }
      }
    }
  }

  /** Escape sequences decoded once, so the loop reads plainly. */
  private static final class Keys {
    static String read(InputStream in) {
      int first = next(in);
      if (first < 0 || first == 3) {
        return "quit";
      }
      if (first == '\r' || first == '\n') {
        return "enter";
      }
      if (first == 127 || first == 8) {
        return "backspace";
      }
      if (first == ' ') {
        return "space";
      }
      if (first != 27) {
        return String.valueOf((char) first);
      }
      int second = next(in);
      if (second != '[' && second != 'O') {
        return "escape";
      }
      int third = next(in);
      return switch (third) {
        case 'A' -> "up";
        case 'B' -> "down";
        case 'C' -> "right";
        case 'D' -> "left";
        case 'H' -> "home";
        case 'F' -> "end";
        case '5', '6', '1', '4' -> {
          int ch = next(in);
          while (ch >= 0 && ch != '~') {
            ch = next(in);
          }
          yield switch (third) {
            case '5' -> "pageup";
            case '6' -> "pagedown";
            case '1' -> "home";
            default -> "end";
          };
        }
        default -> "unknown";
      };
    }

    private static int next(InputStream in) {
      try {
        return in.read();
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    }
  }

  /**
   * Raw mode, borrowed from {@code stty}.
   *
   * <p>Java has no API for this. Shelling out is the standard workaround and it is why the picker
   * is Unix-only: the saved settings are handed back verbatim on the way out, so the terminal is
   * exactly as it was even if the picker exits by exception.
   */
  private static final class Stty {
    static String enterRaw() {
      String saved = run("-g");
      run("raw", "-echo");
      return saved;
    }

    static void restore(String saved) {
      if (saved != null && !saved.isBlank()) {
        run(saved.trim());
      }
    }

    /** The window, or a conservative default when stty cannot say. */
    static int[] size() {
      String out = run("size");
      if (out != null) {
        String[] parts = out.trim().split("\\s+");
        if (parts.length == 2) {
          try {
            return new int[] {Integer.parseInt(parts[1]), Integer.parseInt(parts[0])};
          } catch (NumberFormatException ignored) {
            // Fall through to the default below.
          }
        }
      }
      return new int[] {80, 24};
    }

    private static String run(String... args) {
      List<String> command = new ArrayList<>(List.of("stty"));
      command.addAll(List.of(args));
      try {
        Process process =
            new ProcessBuilder(command)
                .redirectInput(ProcessBuilder.Redirect.INHERIT)
                .redirectErrorStream(true)
                .start();
        String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        process.waitFor();
        return out;
      } catch (IOException e) {
        return null;
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return null;
      }
    }
  }
}
