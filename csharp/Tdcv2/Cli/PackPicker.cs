using System.Globalization;
using System.Text;
using Tdcv2.Packs;

namespace Tdcv2.Cli;

/// <summary>The interactive picker behind <c>tdcv2 pack</c>.</summary>
/// <remarks>
/// <para>
/// The catalogue is 108 bundles and growing. As one flat checkbox list it was unusable: seven rows
/// visible at a time, languages and countries interleaved, and finding Brazil meant paging through
/// the alphabet. So it is browsed the way the catalogue is actually shaped — the locale-agnostic
/// set, then languages, then countries reached through a continent — with search from anywhere and
/// a basket you review before anything is downloaded.
/// </para>
/// <para>
/// The map is not decoration. A continent lights up when you are on it, and every pick burns a
/// spark where that country actually is, so "what have I taken so far" is answerable at a glance.
/// Coordinates come from the registry index, not from a table kept here: the same picker exists in
/// four languages, and four copies of world geography would be four copies that disagree.
/// </para>
/// <para>
/// <b>Raw input.</b> .NET reads a keystroke without a newline on its own, so unlike the Java and
/// Rust pickers this one needs no <c>stty</c> and works on Windows as it does anywhere else.
/// </para>
/// <para>
/// This class draws and returns a decision. It never touches the network or the disk: the caller
/// installs and removes, which keeps the download progress, the digests and the config writing in
/// one place instead of two.
/// </para>
/// </remarks>
public static class PackPicker
{
    /// <summary>What the user decided. <c>null</c> means they left without confirming.</summary>
    public sealed record Decision(IReadOnlyList<string> Install, IReadOnlyList<string> Remove);

    private const string Esc = "\u001b[";

    private static readonly bool Unicode = DetectUnicode();
    private static readonly bool Colour = DetectColour();

    /// <summary>
    /// Half-blocks and colour are detected, never assumed.
    /// </summary>
    /// <remarks>
    /// Modern terminals handle everything here. The old Windows console does not — a raster font
    /// has no "▀" — so the drawing falls back to ASCII, and the map to one row per line instead of
    /// two rows sharing one.
    /// </remarks>
    private static bool DetectUnicode()
    {
        if (Environment.GetEnvironmentVariable("TDCV2_ASCII") is not null)
        {
            return false;
        }

        if (OperatingSystem.IsWindows())
        {
            return Environment.GetEnvironmentVariable("WT_SESSION") is not null
                || Environment.GetEnvironmentVariable("TERM_PROGRAM") is not null
                || Environment.GetEnvironmentVariable("ConEmuANSI") is not null;
        }

        string locale = Environment.GetEnvironmentVariable("LC_ALL")
            ?? Environment.GetEnvironmentVariable("LC_CTYPE")
            ?? Environment.GetEnvironmentVariable("LANG")
            ?? string.Empty;
        return locale.Length == 0
            || locale.Replace("-", string.Empty, StringComparison.Ordinal)
                .Contains("utf8", StringComparison.OrdinalIgnoreCase);
    }

    private static bool DetectColour() =>
        Environment.GetEnvironmentVariable("NO_COLOR") is null
        && Environment.GetEnvironmentVariable("TERM") != "dumb"
        && !Console.IsOutputRedirected;

    private static string Cursor => Unicode ? "❯" : ">";

    private static string Group => Unicode ? "»" : ">";

    private static string On => Unicode ? "▣" : "[x]";

    private static string Off => Unicode ? "▢" : "[ ]";

    private static string Done => Unicode ? "✓" : "[+]";

    private static string Drop => Unicode ? "✗" : "[-]";

    private static string Chip => Unicode ? "■" : "*";

    private static string Land => Unicode ? "█" : "#";

    private sealed record Continent(string Key, string Name, int Colour, int Bright);

    private static readonly Continent[] Continents =
    {
        new("europe", "Europe", 34, 94),
        new("asia", "Asia", 35, 95),
        new("africa", "Africa", 33, 93),
        new("north", "North America", 36, 96),
        new("south", "South America", 32, 92),
        new("oceania", "Oceania", 31, 91),
    };

    /// <summary>
    /// The continents as rough outlines in real coordinates rather than a fixed grid of
    /// characters.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A hand-drawn grid only looks right at the size it was drawn for. Polygons are rasterised
    /// to whatever the window allows, so the shapes survive being made bigger — and each
    /// landmass's coastline falls out of the same data, which is what lets the map be drawn as
    /// outlines.
    /// </para>
    /// <para>
    /// The order is the contract: a pixel takes the FIRST continent whose ring holds it, and
    /// Europe before Asia is what puts the line between them where it is.
    /// </para>
    /// </remarks>
    private static readonly (string Key, double[][][] Rings)[] Outlines =
    {
        ("africa", new[]
        {
            new[] { new[] { -17.0, 15.0 }, new[] { -16.0, 12.0 }, new[] { -13.0, 8.0 }, new[] { -7.0, 4.0 }, new[] { 3.0, 6.0 }, new[] { 9.0, 4.0 }, new[] { 9.0, -1.0 }, new[] { 12.0, -6.0 }, new[] { 13.0, -13.0 }, new[] { 15.0, -22.0 }, new[] { 18.0, -34.0 }, new[] { 25.0, -34.0 }, new[] { 32.0, -26.0 }, new[] { 40.0, -16.0 }, new[] { 41.0, -2.0 }, new[] { 51.0, 12.0 }, new[] { 43.0, 12.0 }, new[] { 37.0, 22.0 }, new[] { 34.0, 28.0 }, new[] { 32.0, 31.0 }, new[] { 20.0, 32.0 }, new[] { 10.0, 34.0 }, new[] { 0.0, 36.0 }, new[] { -6.0, 36.0 }, new[] { -10.0, 30.0 }, new[] { -16.0, 22.0 } },
            new[] { new[] { 44.0, -12.0 }, new[] { 50.0, -15.0 }, new[] { 50.0, -25.0 }, new[] { 45.0, -25.0 }, new[] { 43.0, -16.0 } },
        }),
        ("europe", new[]
        {
            new[] { new[] { -10.0, 36.0 }, new[] { -9.0, 43.0 }, new[] { -2.0, 48.0 }, new[] { -5.0, 50.0 }, new[] { -6.0, 58.0 }, new[] { 5.0, 62.0 }, new[] { 12.0, 68.0 }, new[] { 28.0, 71.0 }, new[] { 40.0, 66.0 }, new[] { 60.0, 66.0 }, new[] { 60.0, 50.0 }, new[] { 50.0, 46.0 }, new[] { 40.0, 44.0 }, new[] { 28.0, 41.0 }, new[] { 24.0, 36.0 }, new[] { 15.0, 38.0 }, new[] { 12.0, 45.0 }, new[] { 3.0, 43.0 } },
        }),
        ("asia", new[]
        {
            new[] { new[] { 60.0, 66.0 }, new[] { 70.0, 73.0 }, new[] { 100.0, 77.0 }, new[] { 140.0, 73.0 }, new[] { 170.0, 68.0 }, new[] { 180.0, 65.0 }, new[] { 180.0, 60.0 }, new[] { 160.0, 60.0 }, new[] { 155.0, 50.0 }, new[] { 142.0, 45.0 }, new[] { 130.0, 35.0 }, new[] { 122.0, 30.0 }, new[] { 110.0, 20.0 }, new[] { 105.0, 10.0 }, new[] { 100.0, 2.0 }, new[] { 95.0, 15.0 }, new[] { 88.0, 21.0 }, new[] { 80.0, 8.0 }, new[] { 72.0, 20.0 }, new[] { 62.0, 25.0 }, new[] { 56.0, 26.0 }, new[] { 52.0, 17.0 }, new[] { 43.0, 12.0 }, new[] { 35.0, 30.0 }, new[] { 36.0, 36.0 }, new[] { 28.0, 41.0 }, new[] { 40.0, 44.0 }, new[] { 50.0, 46.0 }, new[] { 60.0, 50.0 } },
        }),
        ("north", new[]
        {
            new[] { new[] { -168.0, 66.0 }, new[] { -165.0, 60.0 }, new[] { -152.0, 58.0 }, new[] { -140.0, 60.0 }, new[] { -130.0, 54.0 }, new[] { -125.0, 48.0 }, new[] { -124.0, 40.0 }, new[] { -117.0, 32.0 }, new[] { -110.0, 23.0 }, new[] { -105.0, 20.0 }, new[] { -97.0, 16.0 }, new[] { -92.0, 15.0 }, new[] { -84.0, 10.0 }, new[] { -78.0, 8.0 }, new[] { -83.0, 15.0 }, new[] { -88.0, 21.0 }, new[] { -97.0, 26.0 }, new[] { -94.0, 29.0 }, new[] { -89.0, 29.0 }, new[] { -82.0, 25.0 }, new[] { -81.0, 32.0 }, new[] { -76.0, 37.0 }, new[] { -70.0, 43.0 }, new[] { -66.0, 45.0 }, new[] { -60.0, 47.0 }, new[] { -55.0, 52.0 }, new[] { -64.0, 60.0 }, new[] { -78.0, 62.0 }, new[] { -95.0, 60.0 }, new[] { -85.0, 68.0 }, new[] { -100.0, 70.0 }, new[] { -125.0, 70.0 }, new[] { -140.0, 70.0 }, new[] { -160.0, 71.0 } },
            new[] { new[] { -45.0, 60.0 }, new[] { -20.0, 70.0 }, new[] { -20.0, 82.0 }, new[] { -60.0, 83.0 }, new[] { -70.0, 76.0 }, new[] { -55.0, 64.0 } },
        }),
        ("south", new[]
        {
            new[] { new[] { -81.0, 8.0 }, new[] { -77.0, 1.0 }, new[] { -80.0, -5.0 }, new[] { -71.0, -18.0 }, new[] { -70.0, -25.0 }, new[] { -72.0, -40.0 }, new[] { -75.0, -52.0 }, new[] { -68.0, -55.0 }, new[] { -65.0, -42.0 }, new[] { -62.0, -38.0 }, new[] { -57.0, -35.0 }, new[] { -48.0, -25.0 }, new[] { -40.0, -20.0 }, new[] { -35.0, -8.0 }, new[] { -44.0, -2.0 }, new[] { -50.0, 0.0 }, new[] { -60.0, 6.0 }, new[] { -70.0, 11.0 }, new[] { -77.0, 8.0 } },
        }),
        ("oceania", new[]
        {
            new[] { new[] { 114.0, -22.0 }, new[] { 113.0, -26.0 }, new[] { 115.0, -34.0 }, new[] { 129.0, -32.0 }, new[] { 138.0, -35.0 }, new[] { 147.0, -38.0 }, new[] { 150.0, -37.0 }, new[] { 153.0, -28.0 }, new[] { 146.0, -19.0 }, new[] { 142.0, -11.0 }, new[] { 136.0, -12.0 }, new[] { 130.0, -11.0 }, new[] { 125.0, -14.0 }, new[] { 122.0, -18.0 } },
            new[] { new[] { 172.0, -34.0 }, new[] { 174.0, -37.0 }, new[] { 178.0, -38.0 }, new[] { 174.0, -41.0 }, new[] { 171.0, -44.0 }, new[] { 167.0, -46.0 }, new[] { 166.0, -45.0 }, new[] { 170.0, -41.0 } },
        }),
    };

    private const double LonMin = -170;
    private const double LonMax = 190;
    private const double LatMax = 84;
    private const double LatMin = -56;

    /// <summary>Ray casting: is this coordinate inside the ring?</summary>
    private static bool Inside(double lon, double lat, double[][] ring)
    {
        bool hit = false;
        for (int i = 0, j = ring.Length - 1; i < ring.Length; j = i++)
        {
            double xi = ring[i][0];
            double yi = ring[i][1];
            double xj = ring[j][0];
            double yj = ring[j][1];
            if (yi > lat != yj > lat && lon < ((xj - xi) * (lat - yi) / (yj - yi)) + xi)
            {
                hit = !hit;
            }
        }

        return hit;
    }

    /// <summary>Which continent owns each pixel, and whether it sits on a coastline.</summary>
    private sealed record Raster(string?[] LandAt, bool[] EdgeAt);

    private static Raster Rasterise(int w, int h)
    {
        var land = new string?[w * h];
        for (int row = 0; row < h; row++)
        {
            double lat = LatMax - ((row + 0.5) / h * (LatMax - LatMin));
            for (int col = 0; col < w; col++)
            {
                double lon = LonMin + ((col + 0.5) / w * (LonMax - LonMin));
                foreach ((string key, double[][][] rings) in Outlines)
                {
                    if (rings.Any(ring => Inside(lon, lat, ring) || Inside(lon - 360, lat, ring)))
                    {
                        land[(row * w) + col] = key;
                        break;
                    }
                }
            }
        }

        var edge = new bool[w * h];
        for (int row = 0; row < h; row++)
        {
            for (int col = 0; col < w; col++)
            {
                string? here = land[(row * w) + col];
                if (here is null)
                {
                    continue;
                }

                edge[(row * w) + col] = row == 0 || row == h - 1 || col == 0 || col == w - 1
                    || land[((row - 1) * w) + col] != here
                    || land[((row + 1) * w) + col] != here
                    || land[(row * w) + col - 1] != here
                    || land[(row * w) + col + 1] != here;
            }
        }

        return new Raster(land, edge);
    }

    private sealed class Screen
    {
        public Screen(string name)
        {
            Name = name;
        }

        public string Name { get; }

        public int Cursor { get; set; }

        public int Offset { get; set; }
    }

    private enum Kind
    {
        Pack,
        Group,
        Action,
    }

    private sealed record Item(
        Kind Kind, string Label, string Hint, string? Id, string? To, string? Act, string? Region);

    /// <summary>
    /// "Argentina (country)" is right in a printed list and noise in a screen that says so already.
    /// </summary>
    private static string PlainName(string name)
    {
        foreach (string suffix in new[] { " (country)", " (language)", " (locale-agnostic)" })
        {
            if (name.EndsWith(suffix, StringComparison.Ordinal))
            {
                return name[..^suffix.Length].TrimEnd();
            }
        }

        return name;
    }

    // ── the picker ───────────────────────────────────────────────────────────────────────────

    private sealed class State
    {
        private readonly Dictionary<(int W, int H), Raster> _rasters = new();

        public State(IReadOnlyList<PackRegistry.Bundle> bundles, ISet<string> installed)
        {
            Bundles = bundles;
            Installed = installed;
            Stack = new List<Screen> { new("start") };
        }

        public IReadOnlyList<PackRegistry.Bundle> Bundles { get; }

        public ISet<string> Installed { get; }

        public SortedSet<string> Selected { get; } = new(StringComparer.Ordinal);

        public SortedSet<string> Dropping { get; } = new(StringComparer.Ordinal);

        public List<Screen> Stack { get; }

        public string Query { get; set; } = string.Empty;

        public string Flash { get; set; } = string.Empty;

        public bool BodyVisible { get; set; }

        public Screen Top => Stack[^1];

        public Raster RasterFor(int w, int h)
        {
            // Rasterising a hundred thousand pixels is worth doing once per window size, not once
            // per keystroke.
            if (!_rasters.TryGetValue((w, h), out Raster? found))
            {
                found = Rasterise(w, h);
                _rasters[(w, h)] = found;
            }

            return found;
        }

        public PackRegistry.Bundle? ById(string id) =>
            Bundles.FirstOrDefault(b => string.Equals(b.Id, id, StringComparison.Ordinal));

        public string SizeOf(string id) => HumanBytes.Format(ById(id)?.Bytes ?? 0);

        public List<PackRegistry.Bundle> Languages() =>
            Bundles.Where(b => b.Locale is not null).ToList();

        public List<PackRegistry.Bundle> Countries() =>
            Bundles.Where(b => b.Country is not null).ToList();

        public List<PackRegistry.Bundle> Neither() =>
            Bundles.Where(b => b.Locale is null && b.Country is null).ToList();

        public List<PackRegistry.Bundle> InRegion(string key) =>
            Countries().Where(b => b.Regions.Contains(key, StringComparer.Ordinal)).ToList();

        public List<string> NotInstalled() =>
            Bundles.Select(b => b.Id).Where(id => !Installed.Contains(id)).ToList();

        public int PickedIn(IEnumerable<PackRegistry.Bundle> list) =>
            list.Count(b => Selected.Contains(b.Id));
    }

    private static string Sgr(string text, string code) =>
        Colour ? Esc + code + "m" + text + Esc + "0m" : text;

    private static string Dim(string text) => Sgr(text, "2");

    private static string Bold(string text) => Sgr(text, "1");

    private static Item Pack(string id, string label, string hint) =>
        new(Kind.Pack, label, hint, id, null, null, null);

    private static Item GroupItem(string to, string label, string hint, string? region = null) =>
        new(Kind.Group, label, hint, null, to, null, region);

    private static Item Action(string act, string label, string hint) =>
        new(Kind.Action, label, hint, null, null, act, null);

    /// <summary>
    /// The largest map that still leaves room for the list, or null when nothing sensible fits.
    /// </summary>
    private static (int W, int H)? MapSize(int columns, int rows, int reserved)
    {
        for (int w = Math.Min(columns - 4, 132); w >= 56; w -= 4)
        {
            // 360 degrees of longitude against 140 of latitude: keep the ratio so nothing is
            // squashed.
            int h = Math.Max(2, (int)Math.Round(w * 0.39 / 2, MidpointRounding.AwayFromZero) * 2);
            if ((Unicode && Colour ? h / 2 : h) + reserved <= rows)
            {
                return (w, h);
            }
        }

        return null;
    }

    private static List<Item> ItemsFor(State state, Screen screen)
    {
        switch (screen.Name)
        {
            case "start":
            {
                List<string> rest = state.NotInstalled();
                long total = rest.Sum(id => state.ById(id)?.Bytes ?? 0);
                var items = new List<Item>
                {
                    Action(
                        "all",
                        "Everything",
                        rest.Count == 0
                            ? "already installed"
                            : string.Create(
                                CultureInfo.InvariantCulture,
                                $"{rest.Count} not installed · {HumanBytes.Format(total)}")),
                    GroupItem(
                        "browse", "Choose what I need", "by language, by country, or search"),
                };
                if (state.Installed.Count > 0)
                {
                    items.Add(GroupItem(
                        "installed",
                        "Installed packs",
                        string.Create(
                            CultureInfo.InvariantCulture,
                            $"{state.Installed.Count} here · remove any you no longer want")));
                }

                return items;
            }

            case "browse":
            {
                List<PackRegistry.Bundle> languages = state.Languages();
                List<PackRegistry.Bundle> countries = state.Countries();
                List<Item> items = state.Neither()
                    .Select(b => Pack(
                        b.Id,
                        PlainName(b.Name),
                        b.Description.Length > 64 ? b.Description[..64] : b.Description))
                    .ToList();
                int pickedLanguages = state.PickedIn(languages);
                int pickedCountries = state.PickedIn(countries);
                items.Add(GroupItem(
                    "languages",
                    "Languages",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"{languages.Count} available")
                    + (pickedLanguages > 0
                        ? string.Create(CultureInfo.InvariantCulture, $" · {pickedLanguages} picked")
                        : string.Empty)));
                items.Add(GroupItem(
                    "regions",
                    "Countries",
                    string.Create(CultureInfo.InvariantCulture, $"{countries.Count} available")
                    + (pickedCountries > 0
                        ? string.Create(CultureInfo.InvariantCulture, $" · {pickedCountries} picked")
                        : string.Empty)));
                items.Add(GroupItem(
                    "review",
                    "Review and install",
                    state.Selected.Count > 0
                        ? string.Create(
                            CultureInfo.InvariantCulture,
                            $"{state.Selected.Count} in the basket")
                        : "basket is empty"));
                return items;
            }

            case "languages":
                return state.Languages()
                    .Select(b => Pack(
                        b.Id,
                        PlainName(b.Name),
                        string.Create(CultureInfo.InvariantCulture, $"{b.Id} · {state.SizeOf(b.Id)}")))
                    .ToList();

            case "regions":
                return Continents.Select(c =>
                {
                    List<PackRegistry.Bundle> here = state.InRegion(c.Key);
                    int picked = state.PickedIn(here);
                    return GroupItem(
                        "region:" + c.Key,
                        c.Name,
                        string.Create(CultureInfo.InvariantCulture, $"{here.Count} countries")
                        + (picked > 0
                            ? string.Create(CultureInfo.InvariantCulture, $" · {picked} picked")
                            : string.Empty),
                        c.Key);
                }).ToList();

            case "installed":
                return state.Installed.OrderBy(id => id, StringComparer.Ordinal)
                    .Select(id => Pack(
                        id,
                        PlainName(state.ById(id)?.Name ?? id),
                        state.Dropping.Contains(id)
                            ? "marked for removal"
                            : id + " · installed"))
                    .ToList();

            case "review":
            {
                if (state.Selected.Count == 0 && state.Dropping.Count == 0)
                {
                    return new List<Item>();
                }

                long total = state.Selected.Sum(id => state.ById(id)?.Bytes ?? 0);
                List<Item> items = state.Selected
                    .Select(id => Pack(
                        id,
                        PlainName(state.ById(id)?.Name ?? id),
                        string.Create(CultureInfo.InvariantCulture, $"{id} · {state.SizeOf(id)}")))
                    .ToList();
                foreach (string id in state.Dropping)
                {
                    items.Add(Pack(id, PlainName(state.ById(id)?.Name ?? id), "will be removed"));
                }

                var what = new List<string>();
                if (state.Selected.Count > 0)
                {
                    what.Add(string.Create(
                        CultureInfo.InvariantCulture, $"install {state.Selected.Count}"));
                }

                if (state.Dropping.Count > 0)
                {
                    what.Add(string.Create(
                        CultureInfo.InvariantCulture, $"remove {state.Dropping.Count}"));
                }

                items.Add(Action(
                    "confirm",
                    "Apply — " + string.Join(", ", what),
                    state.Selected.Count > 0 ? HumanBytes.Format(total) : string.Empty));
                return items;
            }

            case "search":
            {
                string q = state.Query.Trim().ToLowerInvariant();
                if (q.Length == 0)
                {
                    return new List<Item>();
                }

                return state.Bundles
                    .Where(b => b.Id.Contains(q, StringComparison.Ordinal)
                        || PlainName(b.Name).Contains(q, StringComparison.OrdinalIgnoreCase))
                    .Select(b =>
                    {
                        string where = b.Locale is not null
                            ? "language"
                            : b.Country is not null
                                ? string.Join(
                                    " / ",
                                    Continents
                                        .Where(c => b.Regions.Contains(c.Key, StringComparer.Ordinal))
                                        .Select(c => c.Name))
                                : "no language, no country";
                        return Pack(
                            b.Id,
                            PlainName(b.Name),
                            string.Create(
                                CultureInfo.InvariantCulture, $"{where} · {state.SizeOf(b.Id)}"));
                    })
                    .ToList();
            }

            default:
            {
                string key = screen.Name["region:".Length..];
                return state.InRegion(key)
                    .Select(b => Pack(
                        b.Id,
                        PlainName(b.Name),
                        string.Create(CultureInfo.InvariantCulture, $"{b.Id} · {state.SizeOf(b.Id)}")
                        + (b.Regions.Count > 1 ? " · spans two continents" : string.Empty)))
                    .ToList();
            }
        }
    }

    private static string TitleFor(Screen screen) => screen.Name switch
    {
        "start" => "Data packs",
        "browse" => "Data packs › Choose",
        "languages" => "Data packs › Languages",
        "regions" => "Data packs › Countries",
        "installed" => "Data packs › Installed",
        "review" => "Data packs › Review",
        "search" => "Data packs › Search",
        _ => "Data packs › Countries › " + (Continents
            .FirstOrDefault(c => c.Key == screen.Name["region:".Length..])?.Name
            ?? screen.Name["region:".Length..]),
    };

    // ── the map ──────────────────────────────────────────────────────────────────────────────

    private static List<string> RenderMap(State state, int w, int h, string? focused, int columns)
    {
        Raster map = state.RasterFor(w, h);
        Dictionary<string, int> counts = Continents.ToDictionary(
            c => c.Key, c => state.PickedIn(state.InRegion(c.Key)), StringComparer.Ordinal);

        var lit = new HashSet<int>();
        foreach (string id in state.Selected)
        {
            double[]? point = state.ById(id)?.Point;
            if (point is null || point.Length < 2)
            {
                continue;
            }

            double col = Math.Round(((point[0] - LonMin) / (LonMax - LonMin) * w) - 0.5,
                MidpointRounding.AwayFromZero);
            double row = Math.Round(((LatMax - point[1]) / (LatMax - LatMin) * h) - 0.5,
                MidpointRounding.AwayFromZero);
            if (col >= 0 && col < w && row >= 0 && row < h)
            {
                lit.Add(((int)row * w) + (int)col);
            }
        }

        // Land you have not chosen is a grey body under a coloured coastline: the shape stays
        // readable, but nothing is filled in until you pick it.
        string? Shade(int index)
        {
            if (lit.Contains(index))
            {
                return "1;97";
            }

            string? key = map.LandAt[index];
            if (key is null)
            {
                return null;
            }

            Continent? continent = Continents.FirstOrDefault(c => c.Key == key);
            if (continent is null)
            {
                return null;
            }

            bool isEdge = map.EdgeAt[index];
            if (key == focused)
            {
                return isEdge
                    ? string.Create(CultureInfo.InvariantCulture, $"1;{continent.Bright}")
                    : continent.Colour.ToString(CultureInfo.InvariantCulture);
            }

            if (counts.GetValueOrDefault(key) > 0)
            {
                return isEdge
                    ? continent.Bright.ToString(CultureInfo.InvariantCulture)
                    : string.Create(CultureInfo.InvariantCulture, $"2;{continent.Colour}");
            }

            if (isEdge)
            {
                return continent.Colour.ToString(CultureInfo.InvariantCulture);
            }

            return state.BodyVisible ? "90" : null;
        }

        var lines = new List<string>();
        if (Unicode && Colour)
        {
            for (int row = 0; row < h; row += 2)
            {
                var line = new StringBuilder("  ");
                for (int col = 0; col < w; col++)
                {
                    string? upper = Shade((row * w) + col);
                    string? lower = row + 1 < h ? Shade(((row + 1) * w) + col) : null;
                    if (upper is null && lower is null)
                    {
                        line.Append(' ');
                    }
                    else if (upper is not null && lower is not null)
                    {
                        // One cell, two pixels: the top is drawn, the bottom becomes its
                        // background.
                        int background =
                            int.Parse(lower.Split(';')[^1], CultureInfo.InvariantCulture) + 10;
                        line.Append(Esc).Append(upper).Append(';')
                            .Append(background.ToString(CultureInfo.InvariantCulture))
                            .Append("m▀").Append(Esc).Append("0m");
                    }
                    else if (upper is not null)
                    {
                        line.Append(Esc).Append(upper).Append("m▀").Append(Esc).Append("0m");
                    }
                    else
                    {
                        line.Append(Esc).Append(lower).Append("m▄").Append(Esc).Append("0m");
                    }
                }

                lines.Add(line.ToString());
            }
        }
        else
        {
            // No half-blocks, or no colour to tell the two pixels apart: one row per line,
            // coastlines only. Still a world, and it still shows where a pick landed.
            for (int row = 0; row < h; row++)
            {
                var line = new StringBuilder("  ");
                for (int col = 0; col < w; col++)
                {
                    int index = (row * w) + col;
                    string? code = Shade(index);
                    if (code is null || (!Colour && !map.EdgeAt[index] && !lit.Contains(index)))
                    {
                        line.Append(' ');
                        continue;
                    }

                    line.Append(Colour ? Esc + code + "m" + Land + Esc + "0m" : Land);
                }

                lines.Add(line.ToString());
            }
        }

        List<string> chips = Continents.Select(c =>
        {
            int picked = counts.GetValueOrDefault(c.Key);
            string label = picked > 0
                ? string.Create(CultureInfo.InvariantCulture, $"{c.Name} ({picked})")
                : c.Name;
            return Sgr(
                Chip + " " + label,
                c.Key == focused
                    ? string.Create(CultureInfo.InvariantCulture, $"1;{c.Bright}")
                    : string.Create(CultureInfo.InvariantCulture, $"2;{c.Colour}"));
        }).ToList();

        lines.Add(string.Empty);
        if (columns >= 92)
        {
            lines.Add("  " + string.Join("   ", chips));
        }
        else
        {
            lines.Add("  " + string.Join("   ", chips.Take(3)));
            lines.Add("  " + string.Join("   ", chips.Skip(3)));
        }

        return lines;
    }

    // ── drawing ──────────────────────────────────────────────────────────────────────────────

    private static void Draw(State state, TextWriter output)
    {
        (int columns, int rows) = Window();
        Screen screen = state.Top;
        List<Item> items = ItemsFor(state, screen);

        bool onMap = screen.Name == "regions"
            || screen.Name.StartsWith("region:", StringComparison.Ordinal);
        (int W, int H)? size = onMap ? MapSize(columns, rows, 13) : null;
        int chrome = size is null ? 8 : (Unicode && Colour ? size.Value.H / 2 : size.Value.H) + 13;
        int viewport = Math.Max(4, Math.Min(items.Count, rows - chrome));

        // An empty list still has to draw: clamp the cursor before the row loop reads it.
        screen.Cursor = Math.Min(Math.Max(0, screen.Cursor), Math.Max(0, items.Count - 1));
        if (screen.Cursor < screen.Offset)
        {
            screen.Offset = screen.Cursor;
        }

        if (screen.Cursor >= screen.Offset + viewport)
        {
            screen.Offset = screen.Cursor - viewport + 1;
        }

        screen.Offset = Math.Max(0, screen.Offset);

        var lines = new List<string> { Esc + "2J" + Esc + "H", string.Empty, "  " + Bold(TitleFor(screen)), string.Empty };

        if (size is not null)
        {
            string? focused = screen.Name.StartsWith("region:", StringComparison.Ordinal)
                ? screen.Name["region:".Length..]
                : items.Count > 0 ? items[screen.Cursor].Region : null;
            lines.AddRange(RenderMap(state, size.Value.W, size.Value.H, focused, columns));
            lines.Add(string.Empty);
        }

        if (screen.Name == "search")
        {
            lines.Add("  Search: "
                + (state.Query.Length == 0 ? Dim("type a name…") : Bold(state.Query)));
            lines.Add(string.Empty);
        }

        if (items.Count == 0)
        {
            lines.Add(Dim(screen.Name switch
            {
                "search" => "  nothing matches",
                "review" => "  Nothing picked yet — go back and choose something.",
                _ => "  empty",
            }));
        }

        for (int i = screen.Offset; i < Math.Min(items.Count, screen.Offset + viewport); i++)
        {
            Item item = items[i];
            bool here = i == screen.Cursor;
            string mark = "   ";
            if (item.Kind == Kind.Pack && item.Id is not null)
            {
                mark = state.Dropping.Contains(item.Id) ? Bold(" " + Drop + " ")
                    : state.Selected.Contains(item.Id) ? Bold(" " + On + " ")
                    : state.Installed.Contains(item.Id) ? Dim(" " + Done + " ")
                    : " " + Off + " ";
            }
            else if (item.Kind == Kind.Group)
            {
                mark = " " + Group + " ";
            }

            string label = item.Label.PadRight(26);
            lines.Add("  " + (here ? Bold(Cursor) : " ") + mark
                + (here ? Bold(label) : label) + " " + Dim(item.Hint));
        }

        if (items.Count > viewport)
        {
            lines.Add(string.Empty);
            lines.Add(Dim(string.Create(
                CultureInfo.InvariantCulture,
                $"  {screen.Offset + 1}–{Math.Min(items.Count, screen.Offset + viewport)} of {items.Count}")));
        }

        lines.Add(string.Empty);
        lines.Add(Dim("  " + screen.Name switch
        {
            "search" => "↑↓ move · enter pick · esc leave search",
            "review" => "↑↓ move · space drop · enter apply · backspace back · q cancel",
            "installed" => "↑↓ move · space mark for removal · backspace back · q cancel",
            _ => "↑↓ move · enter open · space pick · / search · m map · backspace back · q cancel",
        }));

        if (state.Selected.Count > 0 || state.Dropping.Count > 0)
        {
            var parts = new List<string>();
            if (state.Selected.Count > 0)
            {
                parts.Add(string.Create(
                    CultureInfo.InvariantCulture, $"{state.Selected.Count} to install"));
            }

            if (state.Dropping.Count > 0)
            {
                parts.Add(string.Create(
                    CultureInfo.InvariantCulture, $"{state.Dropping.Count} to remove"));
            }

            lines.Add("  " + Dim("basket: ") + Bold(string.Join(", ", parts)));
        }

        if (state.Flash.Length > 0)
        {
            lines.Add(string.Empty);
            lines.Add("  " + state.Flash);
        }

        output.Write(string.Join("\n", lines) + "\n");
        output.Flush();
    }

    /// <summary>The window, or a conservative default when the console cannot say.</summary>
    private static (int Columns, int Rows) Window()
    {
        try
        {
            int columns = Console.WindowWidth;
            int rows = Console.WindowHeight;
            return columns > 0 && rows > 0 ? (columns, rows) : (80, 24);
        }
        catch (IOException)
        {
            return (80, 24);
        }
    }

    // ── the loop ─────────────────────────────────────────────────────────────────────────────

    /// <summary>Whether this terminal can host the picker at all.</summary>
    /// <remarks>
    /// Both ends have to be a terminal — a piped stdin has no keystrokes and a piped stdout has
    /// nowhere to draw. Anywhere else the caller prints the list, which answers the same question
    /// with less ceremony.
    /// </remarks>
    public static bool Usable() => !Console.IsInputRedirected && !Console.IsOutputRedirected;

    /// <summary>Browse the catalogue and come back with what to install and what to remove.</summary>
    public static Decision? Run(
        IReadOnlyList<PackRegistry.Bundle> bundles, ISet<string> installed, TextWriter output)
    {
        var state = new State(bundles, installed);
        output.Write(Esc + "?25l");
        try
        {
            return Loop(state, output);
        }
        finally
        {
            // Whatever happened, the terminal goes back exactly as it was found.
            output.Write(Esc + "?25h" + Esc + "2J" + Esc + "H");
            output.Flush();
        }
    }

    private static void Toggle(State state, string id)
    {
        if (state.Top.Name == "installed" || state.Dropping.Contains(id))
        {
            if (!state.Dropping.Remove(id))
            {
                state.Dropping.Add(id);
            }

            return;
        }

        if (state.Installed.Contains(id))
        {
            state.Flash = Dim(id + " is already installed");
            return;
        }

        if (!state.Selected.Remove(id))
        {
            state.Selected.Add(id);
        }
    }

    /// <summary>Space on a continent takes the whole continent — the shortcut for "all of Africa".</summary>
    private static void TakeContinent(State state, string key)
    {
        List<string> here = state.InRegion(key)
            .Where(b => !state.Installed.Contains(b.Id))
            .Select(b => b.Id)
            .ToList();
        bool all = here.All(state.Selected.Contains);
        foreach (string id in here)
        {
            if (all)
            {
                state.Selected.Remove(id);
            }
            else
            {
                state.Selected.Add(id);
            }
        }

        state.Flash = Dim(all ? "continent cleared" : "whole continent added");
    }


    /// <summary>One keystroke, named the way every implementation's loop names it.</summary>
    /// <remarks>
    /// .NET turns an escape sequence into <c>ConsoleKey.UpArrow</c> only where the terminal
    /// database says how; where it cannot, the sequence arrives as its raw bytes and a picker that
    /// trusted the decoding would be one nobody could navigate. So both are handled: a decoded key
    /// is taken as it comes, and a bare escape is read on by hand — the same three-byte shape Java
    /// and Rust decode.
    /// </remarks>
    private static string ReadKeyName()
    {
        ConsoleKeyInfo key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.C && key.Modifiers.HasFlag(ConsoleModifiers.Control))
        {
            return "quit";
        }

        switch (key.Key)
        {
            case ConsoleKey.UpArrow: return "up";
            case ConsoleKey.DownArrow: return "down";
            case ConsoleKey.LeftArrow: return "left";
            case ConsoleKey.RightArrow: return "right";
            case ConsoleKey.PageUp: return "pageup";
            case ConsoleKey.PageDown: return "pagedown";
            case ConsoleKey.Home: return "home";
            case ConsoleKey.End: return "end";
            case ConsoleKey.Enter: return "enter";
            case ConsoleKey.Backspace: return "backspace";
            case ConsoleKey.Spacebar: return "space";
            default: break;
        }

        if (key.KeyChar != '\u001b')
        {
            return key.KeyChar.ToString(CultureInfo.InvariantCulture);
        }

        if (!Console.KeyAvailable)
        {
            return "escape";
        }

        // Two shapes reach here. Raw bytes give "[" and then the letter; .NET, having recognised
        // the introducer but not the whole sequence, eats the "[" and hands over the letter
        // straight away. Measured, not assumed — a probe on this machine reports Escape then "B"
        // for a down arrow.
        char second = Console.ReadKey(intercept: true).KeyChar;
        char third = second;
        if (second == '[' || second == 'O')
        {
            if (!Console.KeyAvailable)
            {
                return "escape";
            }

            third = Console.ReadKey(intercept: true).KeyChar;
        }

        switch (third)
        {
            case 'A': return "up";
            case 'B': return "down";
            case 'C': return "right";
            case 'D': return "left";
            case 'H': return "home";
            case 'F': return "end";
            case '5':
            case '6':
            case '1':
            case '4':
                // A numbered sequence runs on to its "~"; swallow it or the tail arrives as
                // separate keystrokes.
                while (Console.KeyAvailable && Console.ReadKey(intercept: true).KeyChar != '~')
                {
                    // Nothing to do: the bytes belong to the sequence just read.
                }

                return third switch
                {
                    '5' => "pageup",
                    '6' => "pagedown",
                    '1' => "home",
                    _ => "end",
                };
            default: return "unknown";
        }
    }

    private static Decision? Loop(State state, TextWriter output)
    {
        while (true)
        {
            Draw(state, output);
            string key = ReadKeyName();
            Screen screen = state.Top;
            List<Item> items = ItemsFor(state, screen);
            state.Flash = string.Empty;
            Item? current = items.Count > 0 && screen.Cursor < items.Count
                ? items[screen.Cursor]
                : null;

            if (key == "quit")
            {
                return null;
            }

            if (screen.Name == "search")
            {
                if (key == "escape")
                {
                    state.Stack.RemoveAt(state.Stack.Count - 1);
                    state.Query = string.Empty;
                    continue;
                }

                if (key == "backspace")
                {
                    state.Query = state.Query.Length > 0 ? state.Query[..^1] : state.Query;
                    screen.Cursor = 0;
                    continue;
                }

                if (key == "enter")
                {
                    if (current?.Id is not null)
                    {
                        Toggle(state, current.Id);
                    }

                    continue;
                }

                if (key.Length == 1 && !char.IsControl(key[0]))
                {
                    state.Query += key;
                    screen.Cursor = 0;
                    continue;
                }
            }

            int last = Math.Max(0, items.Count - 1);
            switch (key)
            {
                case "q":
                    return null;
                case "up":
                    screen.Cursor = Math.Max(0, screen.Cursor - 1);
                    break;
                case "down":
                    screen.Cursor = Math.Min(last, screen.Cursor + 1);
                    break;
                case "pageup":
                    screen.Cursor = Math.Max(0, screen.Cursor - 10);
                    break;
                case "pagedown":
                    screen.Cursor = Math.Min(last, screen.Cursor + 10);
                    break;
                case "home":
                    screen.Cursor = 0;
                    break;
                case "end":
                    screen.Cursor = last;
                    break;
                case "m":
                    state.BodyVisible = !state.BodyVisible;
                    state.Flash = Dim(state.BodyVisible ? "land filled" : "coastlines only");
                    break;
                case "space":
                    if (current?.Kind == Kind.Pack && current.Id is not null)
                    {
                        Toggle(state, current.Id);
                    }
                    else if (current?.Kind == Kind.Group
                        && current.To?.StartsWith("region:", StringComparison.Ordinal) == true)
                    {
                        TakeContinent(state, current.To["region:".Length..]);
                    }

                    break;
                case "enter":
                    if (current is null)
                    {
                        break;
                    }

                    if (current.Kind == Kind.Group && current.To is not null)
                    {
                        state.Stack.Add(new Screen(current.To));
                    }
                    else if (current.Kind == Kind.Action && current.Act == "all")
                    {
                        foreach (string id in state.NotInstalled())
                        {
                            state.Selected.Add(id);
                        }

                        state.Stack.Add(new Screen("review"));
                    }
                    else if (current.Kind == Kind.Action && current.Act == "confirm")
                    {
                        return new Decision(
                            state.Selected.ToList(), state.Dropping.ToList());
                    }

                    break;
                case "backspace":
                case "escape":
                case "left":
                    if (state.Stack.Count > 1)
                    {
                        state.Stack.RemoveAt(state.Stack.Count - 1);
                    }

                    break;
                default:
                    if (key == "/")
                    {
                        state.Stack.Add(new Screen("search"));
                        state.Query = string.Empty;
                    }

                    break;
            }
        }
    }
}
