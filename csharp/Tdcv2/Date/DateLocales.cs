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
            "январь",
            "февраль",
            "март",
            "апрель",
            "май",
            "июнь",
            "июль",
            "август",
            "сентябрь",
            "октябрь",
            "ноябрь",
            "декабрь",
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
        },
        MonthsInDate: new[]
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
            "styczeń",
            "luty",
            "marzec",
            "kwiecień",
            "maj",
            "czerwiec",
            "lipiec",
            "sierpień",
            "wrzesień",
            "październik",
            "listopad",
            "grudzień",
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
        },
        MonthsInDate: new[]
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
        });

    internal static readonly DateLocale EL = new(
        new[]
        {
            "Ιανουάριος",
            "Φεβρουάριος",
            "Μάρτιος",
            "Απρίλιος",
            "Μάιος",
            "Ιούνιος",
            "Ιούλιος",
            "Αύγουστος",
            "Σεπτέμβριος",
            "Οκτώβριος",
            "Νοέμβριος",
            "Δεκέμβριος",
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
        },
        MonthsInDate: new[]
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
        });

    // Ukrainian, like Russian and Polish, inflects the month name inside a date: the
    // standalone nominative is "січень" but a date reads "18 січня 2026". These are
    // the genitive forms the formatter needs; the nominative list lives in the data
    // pack at uk/date/month.txt.
    internal static readonly DateLocale UK = new(
        new[]
        {
            "січень",
            "лютий",
            "березень",
            "квітень",
            "травень",
            "червень",
            "липень",
            "серпень",
            "вересень",
            "жовтень",
            "листопад",
            "грудень",
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
        },
        MonthsInDate: new[]
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

    // Japanese names months by number, so MMMM is already "10月" and the long formats use the numeric M with 年/月/日 as literals.
    internal static readonly DateLocale JA = new(
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
            "日曜日",
            "月曜日",
            "火曜日",
            "水曜日",
            "木曜日",
            "金曜日",
            "土曜日",
        },
        new[]
        {
            "日",
            "月",
            "火",
            "水",
            "木",
            "金",
            "土",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "YYYY/MM/DD",
            ["LL"] = "YYYY[年]M[月]D[日]",
            ["LLL"] = "YYYY[年]M[月]D[日] HH:mm",
            ["LLLL"] = "YYYY[年]M[月]D[日] dddd HH:mm",
        });

    // Korean names months by number, and a written date reads "2026년 10월 9일" with 년/월/일 as literals.
    internal static readonly DateLocale KO = new(
        new[]
        {
            "1월",
            "2월",
            "3월",
            "4월",
            "5월",
            "6월",
            "7월",
            "8월",
            "9월",
            "10월",
            "11월",
            "12월",
        },
        new[]
        {
            "1월",
            "2월",
            "3월",
            "4월",
            "5월",
            "6월",
            "7월",
            "8월",
            "9월",
            "10월",
            "11월",
            "12월",
        },
        new[]
        {
            "일요일",
            "월요일",
            "화요일",
            "수요일",
            "목요일",
            "금요일",
            "토요일",
        },
        new[]
        {
            "일",
            "월",
            "화",
            "수",
            "목",
            "금",
            "토",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "YYYY. MM. DD.",
            ["LL"] = "YYYY[년] M[월] D[일]",
            ["LLL"] = "YYYY[년] M[월] D[일] HH:mm",
            ["LLLL"] = "YYYY[년] M[월] D[일] dddd HH:mm",
        });

    // Dutch writes month and weekday names in lower case, unlike its German neighbour.
    internal static readonly DateLocale NL = new(
        new[]
        {
            "januari",
            "februari",
            "maart",
            "april",
            "mei",
            "juni",
            "juli",
            "augustus",
            "september",
            "oktober",
            "november",
            "december",
        },
        new[]
        {
            "jan",
            "feb",
            "mrt",
            "apr",
            "mei",
            "jun",
            "jul",
            "aug",
            "sep",
            "okt",
            "nov",
            "dec",
        },
        new[]
        {
            "zondag",
            "maandag",
            "dinsdag",
            "woensdag",
            "donderdag",
            "vrijdag",
            "zaterdag",
        },
        new[]
        {
            "zo",
            "ma",
            "di",
            "wo",
            "do",
            "vr",
            "za",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD-MM-YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D MMMM YYYY HH:mm",
        });

    // Swedish writes month and weekday names in lower case, and Sweden is an ISO-8601 country: the short date is YYYY-MM-DD.
    internal static readonly DateLocale SV = new(
        new[]
        {
            "januari",
            "februari",
            "mars",
            "april",
            "maj",
            "juni",
            "juli",
            "augusti",
            "september",
            "oktober",
            "november",
            "december",
        },
        new[]
        {
            "jan",
            "feb",
            "mar",
            "apr",
            "maj",
            "jun",
            "jul",
            "aug",
            "sep",
            "okt",
            "nov",
            "dec",
        },
        new[]
        {
            "söndag",
            "måndag",
            "tisdag",
            "onsdag",
            "torsdag",
            "fredag",
            "lördag",
        },
        new[]
        {
            "sön",
            "mån",
            "tis",
            "ons",
            "tors",
            "fre",
            "lör",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "YYYY-MM-DD",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D MMMM YYYY HH:mm",
        });

    // Hindi names the Gregorian months with borrowed forms and the weekdays after the planets; the week starts on Sunday.
    internal static readonly DateLocale HI = new(
        new[]
        {
            "जनवरी",
            "फ़रवरी",
            "मार्च",
            "अप्रैल",
            "मई",
            "जून",
            "जुलाई",
            "अगस्त",
            "सितंबर",
            "अक्तूबर",
            "नवंबर",
            "दिसंबर",
        },
        new[]
        {
            "जन.",
            "फ़र.",
            "मार्च",
            "अप्रैल",
            "मई",
            "जून",
            "जुल.",
            "अग.",
            "सित.",
            "अक्तू.",
            "नव.",
            "दिस.",
        },
        new[]
        {
            "रविवार",
            "सोमवार",
            "मंगलवार",
            "बुधवार",
            "गुरुवार",
            "शुक्रवार",
            "शनिवार",
        },
        new[]
        {
            "रवि",
            "सोम",
            "मंगल",
            "बुध",
            "गुरु",
            "शुक्र",
            "शनि",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd, D MMMM YYYY HH:mm",
        });

    // Thailand counts years in the Buddhist Era, 543 ahead of the Common Era: 2026 CE is 2569. The formatter does NOT convert — the year a config supplies is the year printed — so a caller that wants the BE year adds 543 itself. The pack says so in its own date descriptions rather than leaving a silent 543-year error.
    internal static readonly DateLocale TH = new(
        new[]
        {
            "มกราคม",
            "กุมภาพันธ์",
            "มีนาคม",
            "เมษายน",
            "พฤษภาคม",
            "มิถุนายน",
            "กรกฎาคม",
            "สิงหาคม",
            "กันยายน",
            "ตุลาคม",
            "พฤศจิกายน",
            "ธันวาคม",
        },
        new[]
        {
            "ม.ค.",
            "ก.พ.",
            "มี.ค.",
            "เม.ย.",
            "พ.ค.",
            "มิ.ย.",
            "ก.ค.",
            "ส.ค.",
            "ก.ย.",
            "ต.ค.",
            "พ.ย.",
            "ธ.ค.",
        },
        new[]
        {
            "วันอาทิตย์",
            "วันจันทร์",
            "วันอังคาร",
            "วันพุธ",
            "วันพฤหัสบดี",
            "วันศุกร์",
            "วันเสาร์",
        },
        new[]
        {
            "อา.",
            "จ.",
            "อ.",
            "พ.",
            "พฤ.",
            "ศ.",
            "ส.",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD/MM/YYYY",
            ["LL"] = "D MMMM YYYY",
            ["LLL"] = "D MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D MMMM YYYY HH:mm",
        });

    // Czech, like Russian and Polish, inflects the month name inside a date: the standalone nominative is "leden" but a date reads "5. ledna 2026". These are the genitive forms the formatter needs; the nominative list lives in the pack at cs/date/month.txt. Month and weekday names are lower case.
    internal static readonly DateLocale CS = new(
        new[]
        {
            "leden",
            "únor",
            "březen",
            "duben",
            "květen",
            "červen",
            "červenec",
            "srpen",
            "září",
            "říjen",
            "listopad",
            "prosinec",
        },
        new[]
        {
            "led",
            "úno",
            "bře",
            "dub",
            "kvě",
            "čvn",
            "čvc",
            "srp",
            "zář",
            "říj",
            "lis",
            "pro",
        },
        new[]
        {
            "neděle",
            "pondělí",
            "úterý",
            "středa",
            "čtvrtek",
            "pátek",
            "sobota",
        },
        new[]
        {
            "ne",
            "po",
            "út",
            "st",
            "čt",
            "pá",
            "so",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "DD.MM.YYYY",
            ["LL"] = "D. MMMM YYYY",
            ["LLL"] = "D. MMMM YYYY HH:mm",
            ["LLLL"] = "dddd D. MMMM YYYY HH:mm",
        },
        MonthsInDate: new[]
        {
            "ledna",
            "února",
            "března",
            "dubna",
            "května",
            "června",
            "července",
            "srpna",
            "září",
            "října",
            "listopadu",
            "prosince",
        });

    // Hungarian writes a date big-endian — year, month, day — and puts a full stop after EVERY part, the day included: "2026. 10. 09." is a complete date and "2026. 10. 09" is a typo. Month and weekday names are lower case, and the weekday follows the date rather than leading it.
    internal static readonly DateLocale HU = new(
        new[]
        {
            "január",
            "február",
            "március",
            "április",
            "május",
            "június",
            "július",
            "augusztus",
            "szeptember",
            "október",
            "november",
            "december",
        },
        new[]
        {
            "jan.",
            "febr.",
            "márc.",
            "ápr.",
            "máj.",
            "jún.",
            "júl.",
            "aug.",
            "szept.",
            "okt.",
            "nov.",
            "dec.",
        },
        new[]
        {
            "vasárnap",
            "hétfő",
            "kedd",
            "szerda",
            "csütörtök",
            "péntek",
            "szombat",
        },
        new[]
        {
            "V",
            "H",
            "K",
            "Sze",
            "Cs",
            "P",
            "Szo",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "YYYY.MM.DD.",
            ["LL"] = "YYYY. MMMM D.",
            ["LLL"] = "YYYY. MMMM D. HH:mm",
            ["LLLL"] = "YYYY. MMMM D., dddd HH:mm",
        });

    // Finnish, like Czech, inflects the month name inside a date: the month is "tammikuu" but the date reads "5. tammikuuta 2026". These are the partitive forms the formatter needs; the nominative list lives in the pack at fi/date/month.txt. The day number keeps a full stop after it because it is an ordinal, and the time separator is a full stop rather than a colon — 14.30, not 14:30.
    internal static readonly DateLocale FI = new(
        new[]
        {
            "tammikuu",
            "helmikuu",
            "maaliskuu",
            "huhtikuu",
            "toukokuu",
            "kesäkuu",
            "heinäkuu",
            "elokuu",
            "syyskuu",
            "lokakuu",
            "marraskuu",
            "joulukuu",
        },
        new[]
        {
            "tammi",
            "helmi",
            "maalis",
            "huhti",
            "touko",
            "kesä",
            "heinä",
            "elo",
            "syys",
            "loka",
            "marras",
            "joulu",
        },
        new[]
        {
            "sunnuntai",
            "maanantai",
            "tiistai",
            "keskiviikko",
            "torstai",
            "perjantai",
            "lauantai",
        },
        new[]
        {
            "su",
            "ma",
            "ti",
            "ke",
            "to",
            "pe",
            "la",
        },
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["L"] = "D.M.YYYY",
            ["LL"] = "D. MMMM YYYY",
            ["LLL"] = "D. MMMM YYYY HH.mm",
            ["LLLL"] = "dddd D. MMMM YYYY HH.mm",
        },
        MonthsInDate: new[]
        {
            "tammikuuta",
            "helmikuuta",
            "maaliskuuta",
            "huhtikuuta",
            "toukokuuta",
            "kesäkuuta",
            "heinäkuuta",
            "elokuuta",
            "syyskuuta",
            "lokakuuta",
            "marraskuuta",
            "joulukuuta",
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
            ["ja"] = JA,
            ["jpn"] = JA,
            ["ko"] = KO,
            ["kor"] = KO,
            ["nl"] = NL,
            ["nld"] = NL,
            ["cs"] = CS,
            ["ces"] = CS,
            ["th"] = TH,
            ["hi"] = HI,
            ["sv"] = SV,
            ["hu"] = HU,
            ["hun"] = HU,
            ["fi"] = FI,
            ["fin"] = FI,
        };

    /// <summary>The advertised names, for the validator's "did you mean" list.</summary>
    public static IReadOnlyList<string> Names { get; } = new[]
    {
        "ar",
        "cs",
        "de",
        "el",
        "en",
        "es",
        "fi",
        "fr",
        "hu",
        "id",
        "it",
        "ja",
        "ko",
        "hi",
        "nl",
        "pl",
        "pt",
        "ru",
        "sv",
        "th",
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
    /// <summary>
    /// Date locales a DATA PACK shipped, registered by <c>DataPacks</c> when it is built.
    /// </summary>
    /// <remarks>
    /// Seventy locales carry a <c>DATE_LOCALE.json</c> beside their name lists, and for years
    /// the engine never read one: <c>local="ka"</c> drew Georgian names and printed English
    /// months, with the right words sitting in the pack the whole time. The BUILT-IN tables
    /// always win, so the locales the engine always knew keep their bytes, and the registry
    /// only fills the gap.
    /// </remarks>
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, DateLocale>
        PackLocales = new(StringComparer.Ordinal);

    public static void RegisterPackLocale(string name, DateLocale locale) =>
        PackLocales[name] = locale;

    public static DateLocale Resolve(string? name)
    {
        if (name is null)
        {
            return EN;
        }

        if (ByName.TryGetValue(name, out DateLocale? builtIn))
        {
            return builtIn;
        }

        return PackLocales.TryGetValue(name, out DateLocale? fromPack) ? fromPack : EN;
    }

    public static bool IsKnown(string name) =>
        ByName.ContainsKey(name) || PackLocales.ContainsKey(name);
}
