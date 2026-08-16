//! Month and weekday names, one table per language.
//!
//! Not the platform's locale data. Rust's standard library has none at all, and
//! a crate that supplied it would read ICU tables that change between versions
//! and between machines — the same seed would print a different month name on a
//! different computer, which is the one thing the product promises never
//! happens. The names are carried here, byte for byte the same in every
//! implementation.
//!
//! Several languages inflect the month INSIDE a date: Russian's standalone
//! «октябрь» becomes «18 октября 2026», and Polish and Greek do the same. The
//! tables below hold the form a date needs, not the dictionary form; the
//! nominative list lives in the data pack, where a config asking for a month
//! NAME will find it.
//!
//! GENERATED from the reference implementation's own tables — never transcribed
//! by hand, because a single mistyped month name is a bug no test of the
//! FORMATTER would catch.

/// One language's names and its shorthand formats.
///
/// `formats` is L, LL, LLL, LLLL in that order — an array rather than a map,
/// because there are exactly four and they are always all present.
pub struct DateLocale {
    pub months: [&'static str; 12],
    pub months_short: [&'static str; 12],
    /// Sunday first, matching the weekday index the calendar produces.
    pub weekdays: [&'static str; 7],
    pub weekdays_short: [&'static str; 7],
    pub formats: [&'static str; 4],
}

static AR: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "الأحد",
        "الإثنين",
        "الثلاثاء",
        "الأربعاء",
        "الخميس",
        "الجمعة",
        "السبت",
    ],
    weekdays_short: ["أحد", "إثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"],
    formats: [
        "D/M/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd D MMMM YYYY HH:mm",
    ],
};

static DE: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni", "Juli", "Aug.", "Sept.", "Okt.", "Nov.",
        "Dez.",
    ],
    weekdays: [
        "Sonntag",
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag",
    ],
    weekdays_short: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
    formats: [
        "DD.MM.YYYY",
        "D. MMMM YYYY",
        "D. MMMM YYYY HH:mm",
        "dddd, D. MMMM YYYY HH:mm",
    ],
};

static EL: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "Ιαν", "Φεβ", "Μαρ", "Απρ", "Μαΐ", "Ιουν", "Ιουλ", "Αυγ", "Σεπ", "Οκτ", "Νοε", "Δεκ",
    ],
    weekdays: [
        "Κυριακή",
        "Δευτέρα",
        "Τρίτη",
        "Τετάρτη",
        "Πέμπτη",
        "Παρασκευή",
        "Σάββατο",
    ],
    weekdays_short: ["Κυρ", "Δευ", "Τρί", "Τετ", "Πέμ", "Παρ", "Σάβ"],
    formats: [
        "DD/MM/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd, D MMMM YYYY HH:mm",
    ],
};

static EN: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ],
    weekdays: [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ],
    weekdays_short: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    formats: [
        "MM/DD/YYYY",
        "MMMM D, YYYY",
        "MMMM D, YYYY HH:mm",
        "dddd, MMMM D, YYYY HH:mm",
    ],
};

static ES: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "ene.", "feb.", "mar.", "abr.", "may.", "jun.", "jul.", "ago.", "sept.", "oct.", "nov.",
        "dic.",
    ],
    weekdays: [
        "domingo",
        "lunes",
        "martes",
        "miércoles",
        "jueves",
        "viernes",
        "sábado",
    ],
    weekdays_short: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
    formats: [
        "DD/MM/YYYY",
        "D [de] MMMM [de] YYYY",
        "D [de] MMMM [de] YYYY HH:mm",
        "dddd, D [de] MMMM [de] YYYY HH:mm",
    ],
};

static FR: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.",
        "déc.",
    ],
    weekdays: [
        "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
    ],
    weekdays_short: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
    formats: [
        "DD/MM/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd D MMMM YYYY HH:mm",
    ],
};

static IT: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic",
    ],
    weekdays: [
        "domenica",
        "lunedì",
        "martedì",
        "mercoledì",
        "giovedì",
        "venerdì",
        "sabato",
    ],
    weekdays_short: ["dom", "lun", "mar", "mer", "gio", "ven", "sab"],
    formats: [
        "DD/MM/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd D MMMM YYYY HH:mm",
    ],
};

static PL: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru",
    ],
    weekdays: [
        "niedziela",
        "poniedziałek",
        "wtorek",
        "środa",
        "czwartek",
        "piątek",
        "sobota",
    ],
    weekdays_short: ["nd", "pn", "wt", "śr", "cz", "pt", "sb"],
    formats: [
        "DD.MM.YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd, D MMMM YYYY HH:mm",
    ],
};

static PT: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.",
        "dez.",
    ],
    weekdays: [
        "domingo",
        "segunda-feira",
        "terça-feira",
        "quarta-feira",
        "quinta-feira",
        "sexta-feira",
        "sábado",
    ],
    weekdays_short: ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"],
    formats: [
        "DD/MM/YYYY",
        "D [de] MMMM [de] YYYY",
        "D [de] MMMM [de] YYYY HH:mm",
        "dddd, D [de] MMMM [de] YYYY HH:mm",
    ],
};

static RU: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "воскресенье",
        "понедельник",
        "вторник",
        "среда",
        "четверг",
        "пятница",
        "суббота",
    ],
    weekdays_short: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
    formats: [
        "DD.MM.YYYY",
        "D MMMM YYYY г.",
        "D MMMM YYYY г. HH:mm",
        "dddd, D MMMM YYYY г. HH:mm",
    ],
};

static ZH_CN: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
        "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月",
    ],
    weekdays: [
        "星期日",
        "星期一",
        "星期二",
        "星期三",
        "星期四",
        "星期五",
        "星期六",
    ],
    weekdays_short: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    formats: [
        "YYYY/MM/DD",
        "YYYY[年]M[月]D[日]",
        "YYYY[年]M[月]D[日] HH:mm",
        "YYYY[年]M[月]D[日]dddd HH:mm",
    ],
};

/// Every name a config may write, including the three-letter aliases.
// Ukrainian, like Russian and Polish, inflects the month name inside a date: the
// standalone nominative is "січень" but a date reads "18 січня 2026". These are
// the genitive forms the formatter needs; the nominative list lives in the data
// pack at uk/date/month.txt.
static UK: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "неділя",
        "понеділок",
        "вівторок",
        "середа",
        "четвер",
        "п'ятниця",
        "субота",
    ],
    weekdays_short: [
        "нд",
        "пн",
        "вт",
        "ср",
        "чт",
        "пт",
        "сб",
    ],
    formats: [
        "DD.MM.YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd, D MMMM YYYY HH:mm",
    ],
};

// Turkish month names do not inflect, and are capitalised as proper nouns.
static TR: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "Pazar",
        "Pazartesi",
        "Salı",
        "Çarşamba",
        "Perşembe",
        "Cuma",
        "Cumartesi",
    ],
    weekdays_short: [
        "Paz",
        "Pzt",
        "Sal",
        "Çar",
        "Per",
        "Cum",
        "Cmt",
    ],
    formats: [
        "DD.MM.YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd, D MMMM YYYY HH:mm",
    ],
};

// Indonesian month and weekday names do not inflect, and are capitalised.
static ID: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "Minggu",
        "Senin",
        "Selasa",
        "Rabu",
        "Kamis",
        "Jumat",
        "Sabtu",
    ],
    weekdays_short: [
        "Min",
        "Sen",
        "Sel",
        "Rab",
        "Kam",
        "Jum",
        "Sab",
    ],
    formats: [
        "DD/MM/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd, D MMMM YYYY HH:mm",
    ],
};

// Vietnamese names months by number — "tháng 10", not a word of its own — and a full date
// reads "ngày 9 tháng 10 năm 2026", so the long formats carry those three words as literals.
static VI: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "Chủ Nhật",
        "Thứ Hai",
        "Thứ Ba",
        "Thứ Tư",
        "Thứ Năm",
        "Thứ Sáu",
        "Thứ Bảy",
    ],
    weekdays_short: [
        "CN",
        "T2",
        "T3",
        "T4",
        "T5",
        "T6",
        "T7",
    ],
    formats: [
        "DD/MM/YYYY",
        "[ngày] D MMMM [năm] YYYY",
        "[ngày] D MMMM [năm] YYYY HH:mm",
        "dddd, [ngày] D MMMM [năm] YYYY HH:mm",
    ],
};

// Japanese names months by number, so MMMM is already "10月" and the long formats use the numeric M with 年/月/日 as literals.
static JA: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "日曜日",
        "月曜日",
        "火曜日",
        "水曜日",
        "木曜日",
        "金曜日",
        "土曜日",
    ],
    weekdays_short: [
        "日",
        "月",
        "火",
        "水",
        "木",
        "金",
        "土",
    ],
    formats: [
        "YYYY/MM/DD",
        "YYYY[年]M[月]D[日]",
        "YYYY[年]M[月]D[日] HH:mm",
        "YYYY[年]M[月]D[日] dddd HH:mm",
    ],
};

// Korean names months by number, and a written date reads "2026년 10월 9일" with 년/월/일 as literals.
static KO: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "일요일",
        "월요일",
        "화요일",
        "수요일",
        "목요일",
        "금요일",
        "토요일",
    ],
    weekdays_short: [
        "일",
        "월",
        "화",
        "수",
        "목",
        "금",
        "토",
    ],
    formats: [
        "YYYY. MM. DD.",
        "YYYY[년] M[월] D[일]",
        "YYYY[년] M[월] D[일] HH:mm",
        "YYYY[년] M[월] D[일] dddd HH:mm",
    ],
};

// Dutch writes month and weekday names in lower case, unlike its German neighbour.
static NL: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "zondag",
        "maandag",
        "dinsdag",
        "woensdag",
        "donderdag",
        "vrijdag",
        "zaterdag",
    ],
    weekdays_short: [
        "zo",
        "ma",
        "di",
        "wo",
        "do",
        "vr",
        "za",
    ],
    formats: [
        "DD-MM-YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd D MMMM YYYY HH:mm",
    ],
};

// Swedish writes month and weekday names in lower case, and Sweden is an ISO-8601 country: the short date is YYYY-MM-DD.
static SV: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "söndag",
        "måndag",
        "tisdag",
        "onsdag",
        "torsdag",
        "fredag",
        "lördag",
    ],
    weekdays_short: [
        "sön",
        "mån",
        "tis",
        "ons",
        "tors",
        "fre",
        "lör",
    ],
    formats: [
        "YYYY-MM-DD",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd D MMMM YYYY HH:mm",
    ],
};

// Hindi names the Gregorian months with borrowed forms and the weekdays after the planets; the week starts on Sunday.
static HI: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "रविवार",
        "सोमवार",
        "मंगलवार",
        "बुधवार",
        "गुरुवार",
        "शुक्रवार",
        "शनिवार",
    ],
    weekdays_short: [
        "रवि",
        "सोम",
        "मंगल",
        "बुध",
        "गुरु",
        "शुक्र",
        "शनि",
    ],
    formats: [
        "DD/MM/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd, D MMMM YYYY HH:mm",
    ],
};

// Thailand counts years in the Buddhist Era, 543 ahead of the Common Era: 2026 CE is 2569. The formatter does NOT convert — the year a config supplies is the year printed — so a caller that wants the BE year adds 543 itself. The pack says so in its own date descriptions rather than leaving a silent 543-year error.
static TH: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "วันอาทิตย์",
        "วันจันทร์",
        "วันอังคาร",
        "วันพุธ",
        "วันพฤหัสบดี",
        "วันศุกร์",
        "วันเสาร์",
    ],
    weekdays_short: [
        "อา.",
        "จ.",
        "อ.",
        "พ.",
        "พฤ.",
        "ศ.",
        "ส.",
    ],
    formats: [
        "DD/MM/YYYY",
        "D MMMM YYYY",
        "D MMMM YYYY HH:mm",
        "dddd D MMMM YYYY HH:mm",
    ],
};

// Czech, like Russian and Polish, inflects the month name inside a date: the standalone nominative is "leden" but a date reads "5. ledna 2026". These are the genitive forms the formatter needs; the nominative list lives in the pack at cs/date/month.txt. Month and weekday names are lower case.
static CS: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "neděle",
        "pondělí",
        "úterý",
        "středa",
        "čtvrtek",
        "pátek",
        "sobota",
    ],
    weekdays_short: [
        "ne",
        "po",
        "út",
        "st",
        "čt",
        "pá",
        "so",
    ],
    formats: [
        "DD.MM.YYYY",
        "D. MMMM YYYY",
        "D. MMMM YYYY HH:mm",
        "dddd D. MMMM YYYY HH:mm",
    ],
};

// Hungarian writes a date big-endian — year, month, day — and puts a full stop
// after EVERY part, the day included: "2026. 10. 09." is a complete date and
// "2026. 10. 09" is a typo. Month and weekday names are lower case, and the
// weekday follows the date rather than leading it.
static HU: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "vasárnap",
        "hétfő",
        "kedd",
        "szerda",
        "csütörtök",
        "péntek",
        "szombat",
    ],
    weekdays_short: [
        "V",
        "H",
        "K",
        "Sze",
        "Cs",
        "P",
        "Szo",
    ],
    formats: [
        "YYYY.MM.DD.",
        "YYYY. MMMM D.",
        "YYYY. MMMM D. HH:mm",
        "YYYY. MMMM D., dddd HH:mm",
    ],
};

// Finnish, like Czech, inflects the month name inside a date: the month is
// "tammikuu" but the date reads "5. tammikuuta 2026". These are the partitive
// forms the formatter needs; the nominative list lives in the pack at
// fi/date/month.txt. The day number keeps a full stop after it because it is an
// ordinal, and the time separator is a full stop rather than a colon — 14.30.
static FI: DateLocale = DateLocale {
    months: [
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
    ],
    months_short: [
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
    ],
    weekdays: [
        "sunnuntai",
        "maanantai",
        "tiistai",
        "keskiviikko",
        "torstai",
        "perjantai",
        "lauantai",
    ],
    weekdays_short: [
        "su",
        "ma",
        "ti",
        "ke",
        "to",
        "pe",
        "la",
    ],
    formats: [
        "D.M.YYYY",
        "D. MMMM YYYY",
        "D. MMMM YYYY HH.mm",
        "dddd D. MMMM YYYY HH.mm",
    ],
};

static BY_NAME: [(&str, &DateLocale); 44] = [
    ("en", &EN),
    ("eng", &EN),
    ("ru", &RU),
    ("es", &ES),
    ("spa", &ES),
    ("zh-cn", &ZH_CN),
    ("zh", &ZH_CN),
    ("fr", &FR),
    ("fra", &FR),
    ("ar", &AR),
    ("ara", &AR),
    ("pt", &PT),
    ("por", &PT),
    ("de", &DE),
    ("deu", &DE),
    ("it", &IT),
    ("ita", &IT),
    ("pl", &PL),
    ("pol", &PL),
    ("el", &EL),
    ("ell", &EL),
    ("uk", &UK),
    ("ukr", &UK),
    ("tr", &TR),
    ("tur", &TR),
    ("id", &ID),
    ("ind", &ID),
    ("vi", &VI),
    ("vie", &VI),
    ("ja", &JA),
    ("jpn", &JA),
    ("ko", &KO),
    ("kor", &KO),
    ("nl", &NL),
    ("nld", &NL),
    ("cs", &CS),
    ("ces", &CS),
    ("th", &TH),
    ("hi", &HI),
    ("sv", &SV),
    ("hu", &HU),
    ("hun", &HU),
    ("fi", &FI),
    ("fin", &FI),
];

/// The advertised names, for the validator's "did you mean" list.
pub static NAMES: [&str; 24] = [
    "ar", "cs", "de", "el", "en", "es", "fi", "fr", "hu", "id", "it", "ja", "ko", "hi", "nl", "pl", "pt", "ru", "sv", "th", "tr", "uk", "vi", "zh-cn",
];

/// The named locale, falling back to English.
///
/// A fallback rather than an error: a config may name a country pack whose
/// language has no date table of its own yet, and refusing to render a date over
/// that would be a worse answer than English month names.
pub fn resolve(name: Option<&str>) -> &'static DateLocale {
    let Some(name) = name else {
        return &EN;
    };
    BY_NAME
        .iter()
        .find(|(key, _)| *key == name)
        .map_or(&EN, |(_, locale)| *locale)
}

pub fn is_known(name: &str) -> bool {
    BY_NAME.iter().any(|(key, _)| *key == name)
}
