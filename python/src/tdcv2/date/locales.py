"""Month and weekday names, one table per language.

Not the platform's locale data. That would make the same seed print different month names on
different machines, and it is the one thing the product promises never happens — so the names are
carried here, byte for byte the same in every implementation.

Several languages inflect the month INSIDE a date: Russian's standalone "октябрь" becomes
"18 октября 2026", and Polish and Greek do the same. The tables below hold the form a date needs,
not the dictionary form; the nominative list lives in the data pack, where a config asking for a
month NAME will find it.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class DateLocale:
    name: str
    months: tuple[str, ...]
    months_short: tuple[str, ...]
    weekdays: tuple[str, ...]
    """Sunday first, matching the weekday index the calendar returns."""

    weekdays_short: tuple[str, ...]
    formats: dict[str, str]


EN = DateLocale(
    "en",
    (
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
    ),
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"),
    ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"),
    ("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"),
    {
        "L": "MM/DD/YYYY",
        "LL": "MMMM D, YYYY",
        "LLL": "MMMM D, YYYY HH:mm",
        "LLLL": "dddd, MMMM D, YYYY HH:mm",
    },
)

RU = DateLocale(
    "ru",
    (
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
    ),
    (
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
    ),
    ("воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"),
    ("вс", "пн", "вт", "ср", "чт", "пт", "сб"),
    {
        "L": "DD.MM.YYYY",
        "LL": "D MMMM YYYY г.",
        "LLL": "D MMMM YYYY г. HH:mm",
        "LLLL": "dddd, D MMMM YYYY г. HH:mm",
    },
)

# Spanish month and weekday names are lowercase — that is the orthography, not an oversight. `L`
# is day-first like the rest of the Spanish-speaking world, and the long forms carry the "de" that
# Spanish dates require: 18 de octubre de 2026.
ES = DateLocale(
    "es",
    (
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
    ),
    (
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
    ),
    ("domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"),
    ("dom", "lun", "mar", "mié", "jue", "vie", "sáb"),
    {
        "L": "DD/MM/YYYY",
        "LL": "D [de] MMMM [de] YYYY",
        "LLL": "D [de] MMMM [de] YYYY HH:mm",
        "LLLL": "dddd, D [de] MMMM [de] YYYY HH:mm",
    },
)

# Simplified Chinese. The full month NAMES use Chinese numerals — 一月 ("month one") through
# 十二月 — which is the authentic form and the only place in the pack set where a non-Arabic
# numeral system reaches the output. The standard L/LL formats keep Arabic digits for the year and
# day, matching how modern China actually writes dates (2024年1月15日); the Chinese-numeral months
# are reachable through the MMMM token. The literal 年/月/日 separators are bracket-escaped the way
# Spanish's [de] is.
ZH_CN = DateLocale(
    "zh-cn",
    (
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
    ),
    ("1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"),
    ("星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"),
    ("周日", "周一", "周二", "周三", "周四", "周五", "周六"),
    {
        "L": "YYYY/MM/DD",
        "LL": "YYYY[年]M[月]D[日]",
        "LLL": "YYYY[年]M[月]D[日] HH:mm",
        "LLLL": "YYYY[年]M[月]D[日]dddd HH:mm",
    },
)

# French names are lowercase, dates day-first, and the long forms are a bare "D MMMM YYYY" with no
# connector: 18 octobre 2026, mardi 18 octobre 2026 14:05.
FR = DateLocale(
    "fr",
    (
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
    ),
    (
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
    ),
    ("dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"),
    ("dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."),
    {
        "L": "DD/MM/YYYY",
        "LL": "D MMMM YYYY",
        "LLL": "D MMMM YYYY HH:mm",
        "LLLL": "dddd D MMMM YYYY HH:mm",
    },
)

# Arabic uses the Gregorian month names in their Arabic form (يناير…ديسمبر), understood across the
# whole Arab world, rather than the Levantine كانون/شباط set. Day-first like the rest of the
# region. The digits stay ASCII (2026, not ٢٠٢٦) — that matches how most official Arabic dates are
# written and keeps them safe for arithmetic. Rendered lines display right-to-left; the stored
# bytes are in logical order.
AR = DateLocale(
    "ar",
    (
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
    ),
    (
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
    ),
    ("الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"),
    ("أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"),
    {
        "L": "D/M/YYYY",
        "LL": "D MMMM YYYY",
        "LLL": "D MMMM YYYY HH:mm",
        "LLLL": "dddd D MMMM YYYY HH:mm",
    },
)

# Portuguese names are lowercase, dates day-first, and the long forms use the "de" connector
# (18 de outubro de 2026) — the same in European and Brazilian usage.
PT = DateLocale(
    "pt",
    (
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
    ),
    (
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
    ),
    (
        "domingo",
        "segunda-feira",
        "terça-feira",
        "quarta-feira",
        "quinta-feira",
        "sexta-feira",
        "sábado",
    ),
    ("dom", "seg", "ter", "qua", "qui", "sex", "sáb"),
    {
        "L": "DD/MM/YYYY",
        "LL": "D [de] MMMM [de] YYYY",
        "LLL": "D [de] MMMM [de] YYYY HH:mm",
        "LLLL": "dddd, D [de] MMMM [de] YYYY HH:mm",
    },
)

# German is the one Latin-script locale here whose names are CAPITALISED — German capitalises all
# nouns, so "Januar" and "Montag" are correct and the lowercase spelling French, Spanish and
# Portuguese use would be wrong. Day-first with dots, and the long forms carry the ordinal dot
# after the day: 18. Oktober 2026.
DE = DateLocale(
    "de",
    (
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
    ),
    (
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
    ),
    ("Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"),
    ("So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"),
    {
        "L": "DD.MM.YYYY",
        "LL": "D. MMMM YYYY",
        "LLL": "D. MMMM YYYY HH:mm",
        "LLLL": "dddd, D. MMMM YYYY HH:mm",
    },
)

# Italian names are lowercase; day-first with slashes, and the long forms are a bare
# "D MMMM YYYY": 18 ottobre 2026. The grave accents on lunedì…venerdì are part of the spelling.
IT = DateLocale(
    "it",
    (
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
    ),
    ("gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"),
    ("domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"),
    ("dom", "lun", "mar", "mer", "gio", "ven", "sab"),
    {
        "L": "DD/MM/YYYY",
        "LL": "D MMMM YYYY",
        "LLL": "D MMMM YYYY HH:mm",
        "LLLL": "dddd D MMMM YYYY HH:mm",
    },
)

# Polish, like Russian, inflects the month inside a date: the standalone nominative is "styczeń"
# but a date reads "18 stycznia 2026". These are the genitive forms; the nominative list lives in
# the data pack at pl/date/month.txt. Names are lowercase in Polish.
PL = DateLocale(
    "pl",
    (
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
    ),
    ("sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"),
    ("niedziela", "poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota"),
    ("nd", "pn", "wt", "śr", "cz", "pt", "sb"),
    {
        "L": "DD.MM.YYYY",
        "LL": "D MMMM YYYY",
        "LLL": "D MMMM YYYY HH:mm",
        "LLLL": "dddd, D MMMM YYYY HH:mm",
    },
)

# Greek inflects the month inside a date exactly as Russian and Polish do: the standalone
# nominative is "Οκτώβριος" but a date reads "18 Οκτωβρίου 2026". These are the genitive forms;
# the nominative list lives in el/date/month.txt.
EL = DateLocale(
    "el",
    (
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
    ),
    ("Ιαν", "Φεβ", "Μαρ", "Απρ", "Μαΐ", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ"),
    ("Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"),
    ("Κυρ", "Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ"),
    {
        "L": "DD/MM/YYYY",
        "LL": "D MMMM YYYY",
        "LLL": "D MMMM YYYY HH:mm",
        "LLLL": "dddd, D MMMM YYYY HH:mm",
    },
)

# Ukrainian, like Russian and Polish, inflects the month name inside a date: the
# standalone nominative is "січень" but a date reads "18 січня 2026". These are
# the genitive forms the formatter needs; the nominative list lives in the data
# pack at uk/date/month.txt.
UK = DateLocale(
    "uk",
    ("січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"),
    ("січ", "лют", "бер", "квіт", "трав", "черв", "лип", "серп", "вер", "жовт", "лист", "груд"),
    ("неділя", "понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота"),
    ("нд", "пн", "вт", "ср", "чт", "пт", "сб"),
    {"L": "DD.MM.YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd, D MMMM YYYY HH:mm"},
)

# Turkish month names do not inflect, and are capitalised as proper nouns.
TR = DateLocale(
    "tr",
    ("Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"),
    ("Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"),
    ("Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"),
    ("Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"),
    {"L": "DD.MM.YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd, D MMMM YYYY HH:mm"},
)

_BY_NAME: dict[str, DateLocale] = {
    "en": EN,
    "eng": EN,
    "ru": RU,
    "es": ES,
    "spa": ES,
    "zh-cn": ZH_CN,
    "zh": ZH_CN,
    "fr": FR,
    "fra": FR,
    "ar": AR,
    "ara": AR,
    "pt": PT,
    "por": PT,
    "de": DE,
    "deu": DE,
    "it": IT,
    "ita": IT,
    "pl": PL,
    "pol": PL,
    "el": EL,
    "ell": EL,
    "uk": UK,
    "ukr": UK,
    "tr": TR,
    "tur": TR,
}

NAMES = ("ar", "de", "el", "en", "es", "fr", "it", "pl", "pt", "ru", "tr", "uk", "zh-cn")


def resolve(name: str | None) -> DateLocale:
    """The named locale, falling back to English.

    A fallback rather than an error: a config may name a country pack whose language has no date
    table of its own yet, and refusing to render a date over that would be a worse answer than
    English month names.
    """
    return _BY_NAME.get(name or "en", EN)


def is_known(name: str) -> bool:
    return name in _BY_NAME
