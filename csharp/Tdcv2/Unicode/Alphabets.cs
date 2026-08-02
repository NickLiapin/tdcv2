namespace Tdcv2.Unicode;

/// <summary>
/// The named alphabets a config can ask for by name.
/// </summary>
/// <remarks>
/// Spelled out as explicit code-point ranges rather than looked up through Unicode character
/// properties. Property tables ship with the runtime and change between versions of it, so a config
/// that drew Cyrillic letters could quietly draw a different set of them after an upgrade, and two
/// languages' runtimes would never agree. A range written here means the same thing everywhere,
/// forever.
/// </remarks>
public static class Alphabets
{
    private static readonly Dictionary<string, IReadOnlyList<string>> Registry = Build();

    private static Dictionary<string, IReadOnlyList<string>> Build()
    {
        IReadOnlyList<string> latinLower = Between('a', 'z');
        IReadOnlyList<string> latinUpper = Between('A', 'Z');
        IReadOnlyList<string> digits = Between('0', '9');

        // Ё sits outside the alphabetical block in Unicode but inside it in the alphabet, so it is
        // spliced back into place rather than appended.
        var cyrLower = new List<string>(Between('а', 'е')) { "ё" };
        cyrLower.AddRange(Between('ж', 'я'));
        var cyrUpper = new List<string>(Between('А', 'Е')) { "Ё" };
        cyrUpper.AddRange(Between('Ж', 'Я'));

        // Insertion order is preserved, as it is in the reference: an alphabet is a list to draw
        // from, and the order of that list is what the draw index means.
        return new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
        {
            ["latin.lower"] = latinLower,
            ["latin.upper"] = latinUpper,
            ["latin.letters"] = Concat(latinUpper, latinLower),
            ["digits.ascii"] = digits,
            ["digits.fullwidth"] = Between('０', '９'),
            ["cyrillic.ru.lower"] = cyrLower,
            ["cyrillic.ru.upper"] = cyrUpper,
            ["cyrillic.ru.letters"] = Concat(cyrUpper, cyrLower),
            ["greek.letters"] =
                CodePoints("ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω"),
            ["hebrew.letters"] = Between('א', 'ת'),
            ["arabic.letters"] = Between('ء', 'ي'),
            ["kana.hiragana"] = Between('ぁ', 'ゖ'),
            ["kana.katakana"] = Between('ァ', 'ヺ'),
            ["cjk.unified.basic"] = Between('一', '鿿'),
            ["roman.upper"] = CodePoints("IVXLCDM"),
            ["roman.lower"] = CodePoints("ivxlcdm"),
        };
    }

    /// <summary><c>null</c> when the name is unknown; callers report it with the list of known names.</summary>
    public static IReadOnlyList<string>? Chars(string name) =>
        Registry.TryGetValue(name, out IReadOnlyList<string>? chars) ? chars : null;

    public static IReadOnlyList<string> Names() => Registry.Keys.ToList();

    public static IReadOnlyList<string> Between(int start, int end)
    {
        if (start > end)
        {
            throw new ArgumentException("invalid alphabet range");
        }

        var result = new List<string>(end - start + 1);
        for (int cp = start; cp <= end; cp++)
        {
            result.Add(char.ConvertFromUtf32(cp));
        }

        return result;
    }

    /// <summary>One entry per code point, so characters outside the basic plane stay whole.</summary>
    public static IReadOnlyList<string> CodePoints(string value)
    {
        var result = new List<string>();
        for (int i = 0; i < value.Length;)
        {
            int cp = char.ConvertToUtf32(value, i);
            result.Add(char.ConvertFromUtf32(cp));
            i += char.IsHighSurrogate(value[i]) ? 2 : 1;
        }

        return result;
    }

    private static IReadOnlyList<string> Concat(IReadOnlyList<string> a, IReadOnlyList<string> b)
    {
        var result = new List<string>(a.Count + b.Count);
        result.AddRange(a);
        result.AddRange(b);
        return result;
    }
}
