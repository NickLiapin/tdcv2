using System.Collections.Generic;
using System.Dynamic;
using System.Linq;

namespace Tdcv2.Quick;

/// <summary>
/// The quick API: one value, one line, no config file.
/// </summary>
/// <remarks>
/// <code>
/// dynamic tdc = Quick.Tdc;
///
/// tdc.person.male.firstName();           // John
/// tdc.country.usa.docs.ssn();            // 690070001, check digits and all
/// tdc.lang.ru.person.lastName();         // Иванов
/// tdc.person.lastName.many(10);          // ten of them
/// tdc.seed("demo").locale("ru").person.lastName();
/// tdc.gen.number("20..30");              // "23"
/// </code>
/// <para>
/// ONE RULE: a dot in the code is a dot in the address, spelled the way the pack spells it.
/// <c>person.male.firstName</c> here is <c>person.male.firstName</c> in a config, in the
/// reference, and in the other four implementations. That is why the segments are camelCase in
/// C#: they are not names this library chose, they are the names the data already has, and
/// renaming them would be a second vocabulary to keep in step with four other languages.
/// </para>
/// <para>
/// This is the one part of the library that is <c>dynamic</c>, and deliberately: an address is
/// a path through data, not a fixed set of members, and generating a class per pack folder
/// would put a hundred thousand lines of nothing in the assembly. The cost is that a
/// misspelled address is caught when it runs rather than when it compiles — so the message it
/// throws names the nearest real address.
/// </para>
/// <para>
/// WHAT THIS IS NOT. Every call is independent. Nothing here ties one value to another — no
/// <c>&lt;switch&gt;</c> on a drawn column, no <c>parent=</c>, no <c>uniq</c>. A coherent
/// record is a config; this is the drawer of loose values that a faker occupies, answered from
/// the same data packs.
/// </para>
/// </remarks>
public static class Quick
{
    /// <summary>
    /// Words the API answers to at the ROOT, so no data CATEGORY may be called one of them.
    /// <c>location.country</c> is fine — <c>country</c> there is a leaf, and only the first name
    /// after <c>tdc.</c> is intercepted.
    /// </summary>
    public static readonly IReadOnlySet<string> ReservedRootNames =
        new HashSet<string>(System.StringComparer.Ordinal) { "gen", "seed", "locale", "lang", "country" };

    /// <summary>
    /// Words the API answers to at EVERY level of an address, so no segment anywhere may be
    /// called one of them. There is exactly one, and a test holds the bundled packs to it.
    /// </summary>
    public static readonly IReadOnlySet<string> ReservedPathNames =
        new HashSet<string>(System.StringComparer.Ordinal) { "many" };

    /// <summary>
    /// The default entry point: random per process, locale from the project config.
    /// </summary>
    /// <remarks>
    /// Without <c>tdc.seed(...)</c> the quick API is random per process, the way a faker is — a
    /// test that wants the same values twice asks for them by name.
    /// </remarks>
    public static dynamic Tdc => new QuickRoot(RandomSeed(), null);

    /// <summary>The same object under a chosen seed — shorthand for <c>Quick.Tdc.seed(value)</c>.</summary>
    public static dynamic Seed(string value) => new QuickRoot(value, null);

    private static string RandomSeed()
    {
        byte[] bytes = new byte[8];
        System.Security.Cryptography.RandomNumberGenerator.Fill(bytes);
        return System.Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

/// <summary>The object <see cref="Quick.Tdc"/> hands back.</summary>
/// <remarks>
/// <c>seed()</c> and <c>locale()</c> return a NEW object rather than changing this one, so two
/// tests can hold different seeds at once and neither leaks into the other.
/// </remarks>
internal sealed class QuickRoot : DynamicObject
{
    private readonly string _seed;
    private readonly string? _locale;
    private readonly QuickDraw _draw;

    internal QuickRoot(string seed, string? locale)
    {
        _seed = seed;
        _locale = locale;
        _draw = new QuickDraw(seed, locale);
    }

    public override bool TryGetMember(GetMemberBinder binder, out object? result)
    {
        // `lang` and `country` are signposts, not address segments: they say what the next name
        // is, and then step out of the way.
        result = binder.Name switch
        {
            "gen" => new QuickGen(_draw),
            "lang" or "country" => new QuickPack(_draw),
            _ => new QuickAddress(_draw, new[] { binder.Name }),
        };
        return true;
    }

    public override bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result)
    {
        object?[] arguments = args ?? System.Array.Empty<object?>();
        switch (binder.Name)
        {
            case "seed":
                result = new QuickRoot(Text(arguments, 0), _locale);
                return true;
            case "locale":
                result = new QuickRoot(_seed, Text(arguments, 0));
                return true;
            default:
                // `tdc.person.lastName()` reaches TryInvokeMember on the object holding
                // `person`, never here; a call directly on the root is a one-segment address.
                result = new QuickAddress(_draw, new[] { binder.Name }).Draw(arguments);
                return true;
        }
    }

    private static string Text(object?[] args, int index) =>
        args.Length > index && args[index] is not null
            ? args[index]!.ToString()!
            : throw new TdcQuickException("seed() and locale() each need a value");

    public override string ToString() =>
        _locale is null ? $"<tdcv2 quick seed={_seed}>" : $"<tdcv2 quick seed={_seed} locale={_locale}>";
}

/// <summary>
/// What <c>lang</c> and <c>country</c> are: whatever name comes next starts the address.
/// <c>tdc.country.usa.docs.ssn()</c> is the address <c>usa.docs.ssn</c>.
/// </summary>
internal sealed class QuickPack : DynamicObject
{
    private readonly QuickDraw _draw;

    internal QuickPack(QuickDraw draw) => _draw = draw;

    public override bool TryGetMember(GetMemberBinder binder, out object? result)
    {
        result = new QuickAddress(_draw, new[] { binder.Name });
        return true;
    }

    public override bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result)
    {
        result = new QuickAddress(_draw, new[] { binder.Name })
            .Draw(args ?? System.Array.Empty<object?>());
        return true;
    }
}

/// <summary>A dotted address under construction, which is also the call that draws it.</summary>
internal sealed class QuickAddress : DynamicObject
{
    private readonly QuickDraw _draw;
    private readonly string[] _segments;

    internal QuickAddress(QuickDraw draw, string[] segments)
    {
        _draw = draw;
        _segments = segments;
    }

    public override bool TryGetMember(GetMemberBinder binder, out object? result)
    {
        result = new QuickAddress(_draw, _segments.Append(binder.Name).ToArray());
        return true;
    }

    public override bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result)
    {
        object?[] arguments = args ?? System.Array.Empty<object?>();
        if (binder.Name is "many")
        {
            result = DrawMany(arguments);
            return true;
        }

        // `tdc.person.lastName()` lands here with binder.Name == "lastName": the address is this
        // path plus that name, and the call draws it.
        result = new QuickAddress(_draw, _segments.Append(binder.Name).ToArray()).Draw(arguments);
        return true;
    }

    /// <summary>A bare call on an address already complete — <c>tdc.person.lastName.many(3)</c>'s sibling.</summary>
    public override bool TryInvoke(InvokeBinder binder, object?[]? args, out object? result)
    {
        result = Draw(args ?? System.Array.Empty<object?>());
        return true;
    }

    internal string Draw(object?[] args) =>
        _draw.Draw("template", Attributes(args, skip: 0), 1)[0];

    private IReadOnlyList<string> DrawMany(object?[] args)
    {
        if (args.Length == 0 || args[0] is not int count)
        {
            throw new TdcQuickException("many(count) needs a whole number of values");
        }

        return _draw.Draw("template", Attributes(args, skip: 1), count);
    }

    private Dictionary<string, string> Attributes(object?[] args, int skip)
    {
        var attrs = new Dictionary<string, string>(System.StringComparer.Ordinal)
        {
            ["value"] = string.Join(".", _segments),
        };
        foreach (object? arg in args.Skip(skip))
        {
            if (arg is IReadOnlyDictionary<string, string> named)
            {
                foreach (KeyValuePair<string, string> pair in named)
                {
                    attrs[pair.Key] = pair.Value;
                }
            }
            else if (arg is not null)
            {
                throw new TdcQuickException(
                    "an address takes its parameters as a dictionary, "
                    + $"not a {arg.GetType().Name}");
            }
        }

        return attrs;
    }

    public override string ToString() => $"<tdcv2 address {string.Join(".", _segments)}>";
}

/// <summary>
/// <c>tdc.gen.&lt;type&gt;(…)</c> — the engine's own generators, which take attributes rather
/// than addresses. They live under one name because the pack categories are already called
/// <c>date</c>, <c>text</c> and <c>word</c>, so the top level is not free.
/// </summary>
internal sealed class QuickGen : DynamicObject
{
    private readonly QuickDraw _draw;

    internal QuickGen(QuickDraw draw) => _draw = draw;

    public override bool TryGetMember(GetMemberBinder binder, out object? result)
    {
        result = new QuickGenCall(_draw, binder.Name);
        return true;
    }

    public override bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result)
    {
        result = new QuickGenCall(_draw, binder.Name)
            .DrawOne(args ?? System.Array.Empty<object?>());
        return true;
    }
}

/// <summary>One engine generator: <c>tdc.gen.number("20..30")</c> or <c>.many(5, "1..9")</c>.</summary>
internal sealed class QuickGenCall : DynamicObject
{
    private readonly QuickDraw _draw;
    private readonly string _type;

    internal QuickGenCall(QuickDraw draw, string type)
    {
        _draw = draw;
        _type = type;
    }

    public override bool TryInvoke(InvokeBinder binder, object?[]? args, out object? result)
    {
        result = DrawOne(args ?? System.Array.Empty<object?>());
        return true;
    }

    public override bool TryInvokeMember(InvokeMemberBinder binder, object?[]? args, out object? result)
    {
        object?[] arguments = args ?? System.Array.Empty<object?>();
        if (binder.Name is not "many")
        {
            throw new TdcQuickException($"a generator has no member \"{binder.Name}\"");
        }

        if (arguments.Length == 0 || arguments[0] is not int count)
        {
            throw new TdcQuickException("many(count) needs a whole number of values");
        }

        result = _draw.Draw(_type, Attributes(arguments, skip: 1), count);
        return true;
    }

    internal string DrawOne(object?[] args) => _draw.Draw(_type, Attributes(args, skip: 0), 1)[0];

    private Dictionary<string, string> Attributes(object?[] args, int skip)
    {
        var attrs = new Dictionary<string, string>(System.StringComparer.Ordinal);
        foreach (object? arg in args.Skip(skip))
        {
            switch (arg)
            {
                case null:
                    break;

                // A bare string is the `value` attribute, which is what nearly every call wants:
                // tdc.gen.number("20..30") rather than a dictionary of one entry.
                case string value:
                    attrs["value"] = value;
                    break;
                case IReadOnlyDictionary<string, string> named:
                    foreach (KeyValuePair<string, string> pair in named)
                    {
                        attrs[pair.Key] = pair.Value;
                    }

                    break;
                default:
                    throw new TdcQuickException(
                        $"a generator takes a value string or a dictionary, not a {arg.GetType().Name}");
            }
        }

        return attrs;
    }

    public override string ToString() => $"<tdcv2 gen {_type}>";
}
