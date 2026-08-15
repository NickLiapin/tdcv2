namespace Tdcv2.Date;

/// <summary>
/// Month and weekday names, one table per language.
/// </summary>
/// <remarks>
/// <para>
/// Not the platform's locale data. .NET reads month names from ICU or from the host OS, both of
/// which change between versions and between machines; the same seed would print a different month
/// name on a different computer, and that is the one thing the product promises never happens. The
/// names are carried here, byte for byte the same in every implementation.
/// </para>
/// <para>
/// Several languages inflect the month INSIDE a date: Russian's standalone «октябрь» becomes
/// «18 октября 2026», and Polish and Greek do the same. The tables below hold the form a date needs,
/// not the dictionary form; the nominative list lives in the data pack, where a config asking for a
/// month NAME will find it.
/// </para>
/// </remarks>
public static class DateLocales
{
    internal static readonly DateLocale EN = new(
        new[]
        {
            "January",
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December",
        },
        new[]
        {
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        },
        new[]
        {
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        },
        new[]
        {
            "Sun",
            "Mon",
            "Tue",
            "Wed",
            "Thu",
            "Fri",
            "Sat",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "MM/DD/YYYY",
            ["LL"] = "MMMM D, YYYY",
            ["LLL"] = "MMMM D, YYYY HH:mm",
            ["LLLL"] = "dddd, MMMM D, YYYY HH:mm",
        });

    internal static readonly DateLocale RU = new(
        new[]
        {
            "января",
            "февраля",
            "марта",
            "апреля",
            "мая",
            "июня",
            "июля",
            "августа",
            "сентября",
            "октября",
            "ноября",
            "декабря",
        },
        new[]
        {
            "янв.",
            "февр.",
            "март",
            "апр.",
            "май",
            "июнь",
            "июль",
            "авг.",
            "сент.",
            "окт.",
            "нояб.",
            "дек.",
        },
        new[]
        {
            "воскресенье",
            "понедельник",
            "вторник",
            "среда",
            "четверг",
            "пятница",
            "суббота",
        },
        new[]
        {
            "вс",
            "пн",
            "вт",
            "ср",
            "чт",
            "пт",
            "сб",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD.MM.YYYY",
            ["LL"] = "D MMMM YYYY г.",
            ["LLL"] = "D MMMM YYYY г. HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY г. HH:mm",
        });

    internal static readonly DateLocale ES = new(
        new[]
        {
            "enero",
            "febrero",
            "marzo",
            "abril",
            "mayo",
            "junio",
            "julio",
            "agosto",
            "septiembre",
            "octubre",
            "noviembre",
            "diciembre",
        },
        new[]
        {
            "ene.",
            "feb.",
            "mar.",
            "abr.",
            "may.",
            "jun.",
            "jul.",
            "ago.",
            "sept.",
            "oct.",
            "nov.",
            "dic.",
        },
        new[]
        {
            "domingo",
            "lunes",
            "martes",
            "miércoles",
            "jueves",
            "viernes",
            "sábado",
        },
        new[]
        {
            "dom",
            "lun",
            "mar",
            "mié",
            "jue",
            "vie",
            "sáb",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D [de] MMMM [de] YYYY",
            ["LLL"] = "D [de] MMMM [de] YYYY HH:mm",
            ["LLLL"] = "dddd, D [de] MMMM [de] YYYY HH:mm",
        });

    internal static readonly DateLocale ZH_CN = new(
        new[]
        {
            "一月",
            "二月",
            "三月",
            "四月",
            "五月",
            "六月",
            "七月",
            "八月",
            "九月",
            "十月",
            "十一月",
            "十二月",
        },
        new[]
        {
            "1月",
            "2月",
            "3月",
            "4月",
            "5月",
            "6月",
            "7月",
            "8月",
            "9月",
            "10月",
            "11月",
            "12月",
        },
        new[]
        {
            "星期日",
            "星期一",
            "星期二",
            "星期三",
            "星期四",
            "星期五",
            "星期六",
        },
        new[]
        {
            "周日",
            "周一",
            "周二",
            "周三",
            "周四",
            "周五",
            "周六",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "YYYY/MM/DD",
            ["LL"] = "YYYY[年]M[月]D[日]",
            ["LLL"] = "YYYY[年]M[月]D[日] HH:mm",
            ["LLLL"] = "YYYY[年]M[月]D[日]dddd HH:mm",
        });

    internal static readonly DateLocale FR = new(
        new[]
        {
            "janvier",
            "février",
            "mars",
            "avril",
            "mai",
            "juin",
            "juillet",
            "août",
            "septembre",
            "octobre",
            "novembre",
            "décembre",
        },
        new[]
        {
            "janv.",
            "févr.",
            "mars",
            "avr.",
            "mai",
            "juin",
            "juil.",
            "août",
            "sept.",
            "oct.",
            "nov.",
            "déc.",
        },
        new[]
        {
            "dimanche",
            "lundi",
            "mardi",
            "mercredi",
            "jeudi",
            "vendredi",
            "samedi",
        },
        new[]
        {
            "dim.",
            "lun.",
            "mar.",
            "mer.",
            "jeu.",
            "ven.",
            "sam.",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D MMMM YYYY HH:mm",
        });

    internal static readonly DateLocale AR = new(
        new[]
        {
            "يناير",
            "فبراير",
            "مارس",
            "أبريل",
            "مايو",
            "يونيو",
            "يوليو",
            "أغسطس",
            "سبتمبر",
            "أكتوبر",
            "نوفمبر",
            "ديسمبر",
        },
        new[]
        {
            "يناير",
            "فبراير",
            "مارس",
            "أبريل",
            "مايو",
            "يونيو",
            "يوليو",
            "أغسطس",
            "سبتمبر",
            "أكتوبر",
            "نوفمبر",
            "ديسمبر",
        },
        new[]
        {
            "الأحد",
            "الإثنين",
            "الثلاثاء",
            "الأربعاء",
            "الخميس",
            "الجمعة",
            "السبت",
        },
        new[]
        {
            "أحد",
            "إثنين",
            "ثلاثاء",
            "أربعاء",
            "خميس",
            "جمعة",
            "سبت",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "D/M/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D MMMM YYYY HH:mm",
        });

    internal static readonly DateLocale PT = new(
        new[]
        {
            "janeiro",
            "fevereiro",
            "março",
            "abril",
            "maio",
            "junho",
            "julho",
            "agosto",
            "setembro",
            "outubro",
            "novembro",
            "dezembro",
        },
        new[]
        {
            "jan.",
            "fev.",
            "mar.",
            "abr.",
            "mai.",
            "jun.",
            "jul.",
            "ago.",
            "set.",
            "out.",
            "nov.",
            "dez.",
        },
        new[]
        {
            "domingo",
            "segunda-feira",
            "terça-feira",
            "quarta-feira",
            "quinta-feira",
            "sexta-feira",
            "sábado",
        },
        new[]
        {
            "dom",
            "seg",
            "ter",
            "qua",
            "qui",
            "sex",
            "sáb",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D [de] MMMM [de] YYYY",
            ["LLL"] = "D [de] MMMM [de] YYYY HH:mm",
            ["LLLL"] = "dddd, D [de] MMMM [de] YYYY HH:mm",
        });

    internal static readonly DateLocale DE = new(
        new[]
        {
            "Januar",
            "Februar",
            "März",
            "April",
            "Mai",
            "Juni",
            "Juli",
            "August",
            "September",
            "Oktober",
            "November",
            "Dezember",
        },
        new[]
        {
            "Jan.",
            "Feb.",
            "März",
            "Apr.",
            "Mai",
            "Juni",
            "Juli",
            "Aug.",
            "Sept.",
            "Okt.",
            "Nov.",
            "Dez.",
        },
        new[]
        {
            "Sonntag",
            "Montag",
            "Dienstag",
            "Mittwoch",
            "Donnerstag",
            "Freitag",
            "Samstag",
        },
        new[]
        {
            "So",
            "Mo",
            "Di",
            "Mi",
            "Do",
            "Fr",
            "Sa",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD.MM.YYYY",
            ["LL"] = "D. MMMM YYYY",
            ["LLL"] = "D. MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D. MMMM YYYY HH:mm",
        });

    internal static readonly DateLocale IT = new(
        new[]
        {
            "gennaio",
            "febbraio",
            "marzo",
            "aprile",
            "maggio",
            "giugno",
            "luglio",
            "agosto",
            "settembre",
            "ottobre",
            "novembre",
            "dicembre",
        },
        new[]
        {
            "gen",
            "feb",
            "mar",
            "apr",
            "mag",
            "giu",
            "lug",
            "ago",
            "set",
            "ott",
            "nov",
            "dic",
        },
        new[]
        {
            "domenica",
            "lunedì",
            "martedì",
            "mercoledì",
            "giovedì",
            "venerdì",
            "sabato",
        },
        new[]
        {
            "dom",
            "lun",
            "mar",
            "mer",
            "gio",
            "ven",
            "sab",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D MMMM YYYY HH:mm",
        });

    internal static readonly DateLocale PL = new(
        new[]
        {
            "stycznia",
            "lutego",
            "marca",
            "kwietnia",
            "maja",
            "czerwca",
            "lipca",
            "sierpnia",
            "września",
            "października",
            "listopada",
            "grudnia",
        },
        new[]
        {
            "sty",
            "lut",
            "mar",
            "kwi",
            "maj",
            "cze",
            "lip",
            "sie",
            "wrz",
            "paź",
            "lis",
            "gru",
        },
        new[]
        {
            "niedziela",
            "poniedziałek",
            "wtorek",
            "środa",
            "czwartek",
            "piątek",
            "sobota",
        },
        new[]
        {
            "nd",
            "pn",
            "wt",
            "śr",
            "cz",
            "pt",
            "sb",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD.MM.YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY HH:mm",
        });

    internal static readonly DateLocale EL = new(
        new[]
        {
            "Ιανουαρίου",
            "Φεβρουαρίου",
            "Μαρτίου",
            "Απριλίου",
            "Μαΐου",
            "Ιουνίου",
            "Ιουλίου",
            "Αυγούστου",
            "Σεπτεμβρίου",
            "Οκτωβρίου",
            "Νοεμβρίου",
            "Δεκεμβρίου",
        },
        new[]
        {
            "Ιαν",
            "Φεβ",
            "Μαρ",
            "Απρ",
            "Μαΐ",
            "Ιουν",
            "Ιουλ",
            "Αυγ",
            "Σεπ",
            "Οκτ",
            "Νοε",
            "Δεκ",
        },
        new[]
        {
            "Κυριακή",
            "Δευτέρα",
            "Τρίτη",
            "Τετάρτη",
            "Πέμπτη",
            "Παρασκευή",
            "Σάββατο",
        },
        new[]
        {
            "Κυρ",
            "Δευ",
            "Τρί",
            "Τετ",
            "Πέμ",
            "Παρ",
            "Σάβ",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY HH:mm",
        });

    // Ukrainian, like Russian and Polish, inflects the month name inside a date: the
    // standalone nominative is "січень" but a date reads "18 січня 2026". These are
    // the genitive forms the formatter needs; the nominative list lives in the data
    // pack at uk/date/month.txt.
    internal static readonly DateLocale UK = new(
        new[]
        {
            "січня",
            "лютого",
            "березня",
            "квітня",
            "травня",
            "червня",
            "липня",
            "серпня",
            "вересня",
            "жовтня",
            "листопада",
            "грудня",
        },
        new[]
        {
            "січ",
            "лют",
            "бер",
            "квіт",
            "трав",
            "черв",
            "лип",
            "серп",
            "вер",
            "жовт",
            "лист",
            "груд",
        },
        new[]
        {
            "неділя",
            "понеділок",
            "вівторок",
            "середа",
            "четвер",
            "п'ятниця",
            "субота",
        },
        new[]
        {
            "нд",
            "пн",
            "вт",
            "ср",
            "чт",
            "пт",
            "сб",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD.MM.YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY HH:mm",
        });

    // Turkish month names do not inflect, and are capitalised as proper nouns.
    internal static readonly DateLocale TR = new(
        new[]
        {
            "Ocak",
            "Şubat",
            "Mart",
            "Nisan",
            "Mayıs",
            "Haziran",
            "Temmuz",
            "Ağustos",
            "Eylül",
            "Ekim",
            "Kasım",
            "Aralık",
        },
        new[]
        {
            "Oca",
            "Şub",
            "Mar",
            "Nis",
            "May",
            "Haz",
            "Tem",
            "Ağu",
            "Eyl",
            "Eki",
            "Kas",
            "Ara",
        },
        new[]
        {
            "Pazar",
            "Pazartesi",
            "Salı",
            "Çarşamba",
            "Perşembe",
            "Cuma",
            "Cumartesi",
        },
        new[]
        {
            "Paz",
            "Pzt",
            "Sal",
            "Çar",
            "Per",
            "Cum",
            "Cmt",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD.MM.YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY HH:mm",
        });

    // Indonesian month and weekday names do not inflect, and are capitalised.
    internal static readonly DateLocale ID = new(
        new[]
        {
            "Januari",
            "Februari",
            "Maret",
            "April",
            "Mei",
            "Juni",
            "Juli",
            "Agustus",
            "September",
            "Oktober",
            "November",
            "Desember",
        },
        new[]
        {
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "Mei",
            "Jun",
            "Jul",
            "Agu",
            "Sep",
            "Okt",
            "Nov",
            "Des",
        },
        new[]
        {
            "Minggu",
            "Senin",
            "Selasa",
            "Rabu",
            "Kamis",
            "Jumat",
            "Sabtu",
        },
        new[]
        {
            "Min",
            "Sen",
            "Sel",
            "Rab",
            "Kam",
            "Jum",
            "Sab",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY HH:mm",
        });

    // Vietnamese names months by number — "tháng 10", not a word of its own — and a full date
    // reads "ngày 9 tháng 10 năm 2026", so the long formats carry those three words as literals.
    internal static readonly DateLocale VI = new(
        new[]
        {
            "tháng 1",
            "tháng 2",
            "tháng 3",
            "tháng 4",
            "tháng 5",
            "tháng 6",
            "tháng 7",
            "tháng 8",
            "tháng 9",
            "tháng 10",
            "tháng 11",
            "tháng 12",
        },
        new[]
        {
            "Th1",
            "Th2",
            "Th3",
            "Th4",
            "Th5",
            "Th6",
            "Th7",
            "Th8",
            "Th9",
            "Th10",
            "Th11",
            "Th12",
        },
        new[]
        {
            "Chủ Nhật",
            "Thứ Hai",
            "Thứ Ba",
            "Thứ Tư",
            "Thứ Năm",
            "Thứ Sáu",
            "Thứ Bảy",
        },
        new[]
        {
            "CN",
            "T2",
            "T3",
            "T4",
            "T5",
            "T6",
            "T7",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "[ngày] D MMMM [năm] YYYY",
            ["LLL"] = "[ngày] D MMMM [năm] YYYY HH:mm",
            ["LLLL"] = "dddd, [ngày] D MMMM [năm] YYYY HH:mm",
        });

    private static readonly Dictionary<string, DateLocale> ByName =
        new(StringComparer.Ordinal)
        {
            ["en"] = EN,
            ["eng"] = EN,
            ["ru"] = RU,
            ["es"] = ES,
            ["spa"] = ES,
            ["zh-cn"] = ZH_CN,
            ["zh"] = ZH_CN,
            ["fr"] = FR,
            ["fra"] = FR,
            ["ar"] = AR,
            ["ara"] = AR,
            ["pt"] = PT,
            ["por"] = PT,
            ["de"] = DE,
            ["deu"] = DE,
            ["it"] = IT,
            ["ita"] = IT,
            ["pl"] = PL,
            ["pol"] = PL,
            ["el"] = EL,
            ["ell"] = EL,
            ["uk"] = UK,
            ["ukr"] = UK,
            ["tr"] = TR,
            ["tur"] = TR,
            ["id"] = ID,
            ["ind"] = ID,
            ["vi"] = VI,
            ["vie"] = VI,
        };

    /// <summary>The advertised names, for the validator's "did you mean" list.</summary>
    public static IReadOnlyList<string> Names { get; } = new[]
    {
        "ar",
        "de",
        "el",
        "en",
        "es",
        "fr",
        "id",
        "it",
        "pl",
        "pt",
        "ru",
        "tr",
        "uk",
        "vi",
        "zh-cn",
    };

    /// <summary>
    /// The named locale, falling back to English.
    /// </summary>
    /// <remarks>
    /// A fallback rather than an error: a config may name a country pack whose language has no date
    /// table of its own yet, and refusing to render a date over that would be a worse answer than
    /// English month names.
    /// </remarks>
    public static DateLocale Resolve(string? name) =>
        name is not null && ByName.TryGetValue(name, out DateLocale? locale) ? locale : EN;

    public static bool IsKnown(string name) => ByName.ContainsKey(name);
}
