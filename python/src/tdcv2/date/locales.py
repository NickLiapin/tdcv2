"""Month and weekday names, one table per language.

Not the platform's locale data. That would make the same seed print different month names on
different machines, and it is the one thing the product promises never happens — so the names are
carried here, byte for byte the same in every implementation.

Several languages inflect the month INSIDE a date: Russian's standalone "октябрь" becomes
"18 октября 2026", and Polish, Ukrainian, Greek, Czech and Finnish do the same. These tables used
to hold ONLY the form a date needs, and sent anyone wanting the dictionary form to the data pack's
own month list. That was a deliberate boundary, and it had one hole: a config writing
``format="MMMM"`` — a month column, a report heading — was never told, and got "октября" where it
meant "октябрь".

So both forms live here now. ``months`` is the standalone, dictionary form; ``months_in_date`` is
the one a date needs, and is ``None`` for the languages that do not distinguish them. The
formatter picks between them from the format string alone — see ``_render`` in ``formatter.py``.
The pack's month list is still there and still correct; it is no longer the only way to get a
month's name right.
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

    months_in_date: tuple[str, ...] | None = None
    """The month as it is written WITH a day number beside it.

    Russian ``январь`` becomes ``15 января``; Finnish ``tammikuu`` becomes ``15. tammikuuta``.
    ``None`` when the language does not distinguish the two — English does not, and Hungarian
    keeps the nominative — in which case ``months`` is used for both.
    """


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
    months_in_date=(
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
    months_in_date=(
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
)

# Greek inflects the month inside a date exactly as Russian and Polish do: the standalone
# nominative is "Οκτώβριος" but a date reads "18 Οκτωβρίου 2026". These are the genitive forms;
# the nominative list lives in el/date/month.txt.
EL = DateLocale(
    "el",
    (
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
    months_in_date=(
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
)

# Ukrainian, like Russian and Polish, inflects the month name inside a date: the
# standalone nominative is "січень" but a date reads "18 січня 2026". These are
# the genitive forms the formatter needs; the nominative list lives in the data
# pack at uk/date/month.txt.
UK = DateLocale(
    "uk",
    (
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
    ),
    ("січ", "лют", "бер", "квіт", "трав", "черв", "лип", "серп", "вер", "жовт", "лист", "груд"),
    ("неділя", "понеділок", "вівторок", "середа", "четвер", "п'ятниця", "субота"),
    ("нд", "пн", "вт", "ср", "чт", "пт", "сб"),
    {"L": "DD.MM.YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd, D MMMM YYYY HH:mm"},
    months_in_date=("січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня")
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

# Indonesian month and weekday names do not inflect, and are capitalised.
ID = DateLocale(
    "id",
    ("Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"),
    ("Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"),
    ("Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"),
    ("Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"),
    {"L": "DD/MM/YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd, D MMMM YYYY HH:mm"},
)

# Vietnamese names months by number — "tháng 10", not a word of its own — and a full date
# reads "ngày 9 tháng 10 năm 2026", so the long formats carry those three words as literals.
VI = DateLocale(
    "vi",
    ("tháng 1", "tháng 2", "tháng 3", "tháng 4", "tháng 5", "tháng 6", "tháng 7", "tháng 8", "tháng 9", "tháng 10", "tháng 11", "tháng 12"),
    ("Th1", "Th2", "Th3", "Th4", "Th5", "Th6", "Th7", "Th8", "Th9", "Th10", "Th11", "Th12"),
    ("Chủ Nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"),
    ("CN", "T2", "T3", "T4", "T5", "T6", "T7"),
    {"L": "DD/MM/YYYY", "LL": "[ngày] D MMMM [năm] YYYY", "LLL": "[ngày] D MMMM [năm] YYYY HH:mm", "LLLL": "dddd, [ngày] D MMMM [năm] YYYY HH:mm"},
)

# Japanese names months by number, so MMMM is already "10月" and the long formats use the numeric M with 年/月/日 as literals.
JA = DateLocale(
    "ja",
    ("1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"),
    ("1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"),
    ("日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"),
    ("日", "月", "火", "水", "木", "金", "土"),
    {"L": "YYYY/MM/DD", "LL": "YYYY[年]M[月]D[日]", "LLL": "YYYY[年]M[月]D[日] HH:mm", "LLLL": "YYYY[年]M[月]D[日] dddd HH:mm"},
)

# Korean names months by number, and a written date reads "2026년 10월 9일" with 년/월/일 as literals.
KO = DateLocale(
    "ko",
    ("1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"),
    ("1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"),
    ("일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"),
    ("일", "월", "화", "수", "목", "금", "토"),
    {"L": "YYYY. MM. DD.", "LL": "YYYY[년] M[월] D[일]", "LLL": "YYYY[년] M[월] D[일] HH:mm", "LLLL": "YYYY[년] M[월] D[일] dddd HH:mm"},
)

# Dutch writes month and weekday names in lower case, unlike its German neighbour.
NL = DateLocale(
    "nl",
    ("januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"),
    ("jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"),
    ("zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"),
    ("zo", "ma", "di", "wo", "do", "vr", "za"),
    {"L": "DD-MM-YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd D MMMM YYYY HH:mm"},
)

# Swedish writes month and weekday names in lower case, and Sweden is an ISO-8601 country: the short date is YYYY-MM-DD.
SV = DateLocale(
    "sv",
    ("januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"),
    ("jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"),
    ("söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"),
    ("sön", "mån", "tis", "ons", "tors", "fre", "lör"),
    {"L": "YYYY-MM-DD", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd D MMMM YYYY HH:mm"},
)

# Hindi names the Gregorian months with borrowed forms and the weekdays after the planets; the week starts on Sunday.
HI = DateLocale(
    "hi",
    ("जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्तूबर", "नवंबर", "दिसंबर"),
    ("जन.", "फ़र.", "मार्च", "अप्रैल", "मई", "जून", "जुल.", "अग.", "सित.", "अक्तू.", "नव.", "दिस."),
    ("रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"),
    ("रवि", "सोम", "मंगल", "बुध", "गुरु", "शुक्र", "शनि"),
    {"L": "DD/MM/YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd, D MMMM YYYY HH:mm"},
)

# Thailand counts years in the Buddhist Era, 543 ahead of the Common Era: 2026 CE is 2569. The formatter does NOT convert — the year a config supplies is the year printed — so a caller that wants the BE year adds 543 itself. The pack says so in its own date descriptions rather than leaving a silent 543-year error.
TH = DateLocale(
    "th",
    ("มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"),
    ("ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."),
    ("วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"),
    ("อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."),
    {"L": "DD/MM/YYYY", "LL": "D MMMM YYYY", "LLL": "D MMMM YYYY HH:mm", "LLLL": "dddd D MMMM YYYY HH:mm"},
)

# Czech, like Russian and Polish, inflects the month name inside a date: the standalone nominative is "leden" but a date reads "5. ledna 2026". These are the genitive forms the formatter needs; the nominative list lives in the pack at cs/date/month.txt. Month and weekday names are lower case.
CS = DateLocale(
    "cs",
    (
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
    ),
    ("led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"),
    ("neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"),
    ("ne", "po", "út", "st", "čt", "pá", "so"),
    {"L": "DD.MM.YYYY", "LL": "D. MMMM YYYY", "LLL": "D. MMMM YYYY HH:mm", "LLLL": "dddd D. MMMM YYYY HH:mm"},
    months_in_date=("ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince")
)

# Hungarian writes a date big-endian — year, month, day — and puts a full stop after EVERY part, the day included: "2026. 10. 09." is a complete date and "2026. 10. 09" is a typo. Month and weekday names are lower case, and the weekday follows the date rather than leading it.
HU = DateLocale(
    "hu",
    ("január", "február", "március", "április", "május", "június", "július", "augusztus", "szeptember", "október", "november", "december"),
    ("jan.", "febr.", "márc.", "ápr.", "máj.", "jún.", "júl.", "aug.", "szept.", "okt.", "nov.", "dec."),
    ("vasárnap", "hétfő", "kedd", "szerda", "csütörtök", "péntek", "szombat"),
    ("V", "H", "K", "Sze", "Cs", "P", "Szo"),
    {"L": "YYYY.MM.DD.", "LL": "YYYY. MMMM D.", "LLL": "YYYY. MMMM D. HH:mm", "LLLL": "YYYY. MMMM D., dddd HH:mm"},
)

# Finnish, like Czech, inflects the month name inside a date: the month is "tammikuu" but the date reads "5. tammikuuta 2026". These are the partitive forms the formatter needs; the nominative list lives in the pack at fi/date/month.txt. The day number keeps a full stop after it because it is an ordinal, and the time separator is a full stop rather than a colon — 14.30, not 14:30.
FI = DateLocale(
    "fi",
    (
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
    ),
    ("tammi", "helmi", "maalis", "huhti", "touko", "kesä", "heinä", "elo", "syys", "loka", "marras", "joulu"),
    ("sunnuntai", "maanantai", "tiistai", "keskiviikko", "torstai", "perjantai", "lauantai"),
    ("su", "ma", "ti", "ke", "to", "pe", "la"),
    {"L": "D.M.YYYY", "LL": "D. MMMM YYYY", "LLL": "D. MMMM YYYY HH.mm", "LLLL": "dddd D. MMMM YYYY HH.mm"},
    months_in_date=("tammikuuta", "helmikuuta", "maaliskuuta", "huhtikuuta", "toukokuuta", "kesäkuuta", "heinäkuuta", "elokuuta", "syyskuuta", "lokakuuta", "marraskuuta", "joulukuuta")
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
    "id": ID,
    "ind": ID,
    "vi": VI,
    "vie": VI,
    "ja": JA,
    "jpn": JA,
    "ko": KO,
    "kor": KO,
    "nl": NL,
    "nld": NL,
    "cs": CS,
    "ces": CS,
    "th": TH,
    "hi": HI,
    "sv": SV,
    "hu": HU,
    "hun": HU,
    "fi": FI,
    "fin": FI,
}

NAMES = ("ar", "cs", "de", "el", "en", "es", "fi", "fr", "hu", "id", "it", "ja", "ko", "hi", "nl", "pl", "pt", "ru", "sv", "th", "tr", "uk", "vi", "zh-cn")


def resolve(name: str | None) -> DateLocale:
    """The named locale, falling back to English.

    A fallback rather than an error: a config may name a country pack whose language has no date
    table of its own yet, and refusing to render a date over that would be a worse answer than
    English month names.
    """
    return _BY_NAME.get(name or "en", EN)


def is_known(name: str) -> bool:
    return name in _BY_NAME
