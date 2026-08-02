using System.Collections.Generic;
using System.Linq;
using Tdcv2.Packs;

namespace Tdcv2.Quick;

/// <summary>
/// The machinery under the quick API: one generator, an endless stream of values.
/// </summary>
/// <remarks>
/// <para>
/// A quick call has to look like a faker's and cost about what one costs. Two measured facts
/// shape everything here, and they are the same two the TypeScript implementation is built
/// around.
/// </para>
/// <para>
/// FIRST, values depend on the row COUNT, not only on the seed. The same config run with
/// <c>count="3"</c> yields <c>John | Robert | James</c>, and run three times with
/// <c>count="1"</c> yields <c>James | James | James</c>. So a call cannot mean "render one
/// row", or a loop of calls returns the same value forever. It means "take the next value
/// from a stream".
/// </para>
/// <para>
/// SECOND, iteration is lazy, so a stream is cheap to open and cheap to abandon. A stream is
/// therefore a run of <see cref="BatchRows"/> rows; when it is exhausted the next run starts
/// under a seed derived from the batch number, so the sequence continues without bound and
/// stays reproducible from the same starting seed.
/// </para>
/// <para>
/// Every number and every string here is part of the cross-language contract. The batch size,
/// the <c>#</c> in the derived seed, the sequence name <c>V</c> and the shape of the
/// synthesised config all match <c>typescript/src/quick/draw.ts</c> exactly, which is what
/// makes the same seed give the same values in every implementation.
/// </para>
/// </remarks>
public sealed class QuickDraw
{
    /// <summary>
    /// Rows per underlying run. Small enough that opening a stream is free, large enough that a
    /// test drawing a few hundred values never reopens one.
    /// </summary>
    /// <remarks>
    /// Part of the contract: change it and every seeded value changes, because the draw depends
    /// on the declared count.
    /// </remarks>
    public const int BatchRows = 512;

    private sealed class Cursor
    {
        public int Batch;
        public IEnumerator<Tdc.Row> Rows = null!;
    }

    private readonly Dictionary<string, Cursor> _cursors = new(System.StringComparer.Ordinal);
    private readonly string _seed;
    private readonly string? _locale;

    public QuickDraw(string seed, string? locale)
    {
        _seed = seed;
        _locale = locale;
    }

    public IReadOnlyList<string> Draw(string genType, IReadOnlyDictionary<string, string> attrs, int count)
    {
        if (count < 1)
        {
            throw new TdcQuickException($"count must be a positive whole number, got {count}");
        }

        string key = KeyOf(genType, attrs);
        if (!_cursors.TryGetValue(key, out Cursor? cursor))
        {
            cursor = new Cursor { Batch = 0, Rows = Open(genType, attrs, 0) };
            _cursors[key] = cursor;
        }

        var output = new List<string>(count);
        while (output.Count < count)
        {
            if (!cursor.Rows.MoveNext())
            {
                cursor.Batch++;
                cursor.Rows = Open(genType, attrs, cursor.Batch);
                continue;
            }

            // One sequence, one column: the row is { V = <the value> }. A compound row cannot
            // appear here — this layer never builds one.
            output.Add(cursor.Rows.Current["V"] ?? string.Empty);
        }

        return output;
    }

    private IEnumerator<Tdc.Row> Open(string genType, IReadOnlyDictionary<string, string> attrs, int batch)
    {
        string seed = batch == 0 ? _seed : $"{_seed}#{batch}";
        try
        {
            return new Tdc(new Tdc.Options
            {
                ConfigString = ConfigFor(genType, attrs, _locale, seed),
            }).Rows().GetEnumerator();
        }
        catch (System.Exception error)
        {
            throw Explain(genType, attrs, error);
        }
    }

    /// <summary>
    /// Turn an engine diagnostic about a config the caller never wrote into a sentence about the
    /// call they did write — but only when the address really is what went wrong.
    /// </summary>
    /// <remarks>
    /// Rewriting every failure hides the one line that says what is actually wrong: an attribute
    /// the validator refused came back as <c>unknown address "common.internet.email". Did you
    /// mean "common.internet.email"?</c>, which is nonsense.
    /// </remarks>
    private System.Exception Explain(
        string genType,
        IReadOnlyDictionary<string, string> attrs,
        System.Exception error)
    {
        if (genType != "template")
        {
            return error;
        }

        string address = attrs.TryGetValue("value", out string? v) ? v : string.Empty;
        string locale = _locale ?? "en";
        List<string> known = KnownAddresses();

        string? missing = UninstalledPack(address, known);
        if (missing is not null)
        {
            return new TdcQuickException(
                $"the \"{missing}\" pack is not installed, so \"{address}\" cannot be drawn. " +
                $"Install it with `tdcv2 pack add {missing}` " +
                "(run `tdcv2 init` once first, to say where packs go).");
        }

        if (known.Contains(address) || known.Contains($"{locale}.{address}"))
        {
            return error;
        }

        string? near = Nearest(address, locale, known);
        string hint = near is null ? string.Empty : $". Did you mean \"{near}\"?";
        return new TdcQuickException($"unknown address \"{address}\" (locale \"{locale}\"){hint}");
    }

    private static List<string> KnownAddresses()
    {
        try
        {
            return DataPacks.ForProject(System.IO.Directory.GetCurrentDirectory()).AddressList().ToList();
        }
        catch (System.Exception)
        {
            // A broken project config must not hide the real error behind its own.
            return new List<string>();
        }
    }

    /// <summary>
    /// The pack an address names, when that pack is real but not on this machine.
    /// </summary>
    /// <remarks>
    /// A build carries a starter set — <c>common</c>, <c>en</c>, <c>usa</c> — and the registry
    /// carries the other hundred-odd, so <c>ru.person.lastName</c> on a fresh checkout fails not
    /// because <c>ru</c> is a typo but because <c>ru</c> has not been downloaded. The test is
    /// structural rather than a table of locale codes, so it holds for packs that do not exist
    /// yet: nothing at all under the first segment, but the REST of the address resolves
    /// somewhere. A typo in the tail fails one of the two halves and falls through to the
    /// nearest address.
    /// </remarks>
    private static string? UninstalledPack(string address, List<string> known)
    {
        int dot = address.IndexOf('.');
        if (dot <= 0 || dot == address.Length - 1)
        {
            return null;
        }

        string head = address[..dot];
        string tail = address[(dot + 1)..];
        string prefix = head + ".";
        if (known.Any(a => a.StartsWith(prefix, System.StringComparison.Ordinal)))
        {
            return null;
        }

        string suffix = "." + tail;
        bool tailResolves = known.Any(a =>
            a == tail || a.EndsWith(suffix, System.StringComparison.Ordinal));
        return tailResolves ? head : null;
    }

    /// <summary>
    /// The nearest reachable address to what was typed, compared against the address as written
    /// AND against its locale-qualified form: <c>person.firstNam</c> and
    /// <c>en.person.firstNam</c> are the same typo seen from two sides.
    /// </summary>
    private static string? Nearest(string typed, string locale, List<string> known)
    {
        string qualified = $"{locale}.{typed}";
        string? best = null;
        int bestScore = int.MaxValue;
        foreach (string address in known)
        {
            int score = System.Math.Min(Distance(typed, address), Distance(qualified, address));
            if (score < bestScore)
            {
                bestScore = score;
                best = address;
            }
        }

        // Three edits away is a different address, not a typo.
        return bestScore <= 3 ? best : null;
    }

    private static int Distance(string a, string b)
    {
        var prev = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++)
        {
            prev[j] = j;
        }

        for (int i = 1; i <= a.Length; i++)
        {
            int carry = prev[0];
            prev[0] = i;
            for (int j = 1; j <= b.Length; j++)
            {
                int keep = prev[j];
                prev[j] = System.Math.Min(
                    System.Math.Min(prev[j] + 1, prev[j - 1] + 1),
                    carry + (a[i - 1] == b[j - 1] ? 0 : 1));
                carry = keep;
            }
        }

        return prev[b.Length];
    }

    private static string ConfigFor(
        string genType,
        IReadOnlyDictionary<string, string> attrs,
        string? locale,
        string seed)
    {
        string rendered = string.Concat(attrs.Select(a => $" {a.Key}=\"{Escape(a.Value)}\""));
        string local = locale is null ? string.Empty : $" local=\"{Escape(locale)}\"";
        return $"<tdc><env count=\"{BatchRows}\" seed=\"{Escape(seed)}\"{local}>"
            + $"<sequence name=\"V\"><gen type=\"{genType}\"{rendered}/></sequence></env>"
            + "<block><line><data>${{V}}</data></line></block></tdc>";
    }

    private static string Escape(string value)
    {
        if (value.Contains('"'))
        {
            throw new TdcQuickException($"a double quote is not allowed in a generator value: {value}");
        }

        return value;
    }

    private static string KeyOf(string genType, IReadOnlyDictionary<string, string> attrs)
    {
        IEnumerable<string> pairs = attrs
            .OrderBy(a => a.Key, System.StringComparer.Ordinal)
            .Select(a => $"{a.Key}={a.Value}");
        return $"{genType}|{string.Join("&", pairs)}";
    }
}

/// <summary>Raised for anything the quick API can explain better than the engine can.</summary>
public sealed class TdcQuickException : System.Exception
{
    public TdcQuickException(string message)
        : base(message)
    {
    }
}
