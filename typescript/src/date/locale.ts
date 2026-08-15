/**
 * Date locale registry used by the portable TDC date formatter.
 */

export interface DateLocale {
  readonly name: string;
  readonly months: readonly string[];
  readonly monthsShort: readonly string[];
  readonly weekdays: readonly string[];
  readonly weekdaysShort: readonly string[];
  readonly formats: Readonly<Record<'L' | 'LL' | 'LLL' | 'LLLL', string>>;
}

const EN: DateLocale = {
  name: 'en',
  months: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  formats: {
    L: 'MM/DD/YYYY',
    LL: 'MMMM D, YYYY',
    LLL: 'MMMM D, YYYY HH:mm',
    LLLL: 'dddd, MMMM D, YYYY HH:mm',
  },
};

const RU: DateLocale = {
  name: 'ru',
  months: [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ],
  monthsShort: [
    'янв.',
    'февр.',
    'март',
    'апр.',
    'май',
    'июнь',
    'июль',
    'авг.',
    'сент.',
    'окт.',
    'нояб.',
    'дек.',
  ],
  weekdays: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
  weekdaysShort: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  formats: {
    L: 'DD.MM.YYYY',
    LL: 'D MMMM YYYY г.',
    LLL: 'D MMMM YYYY г. HH:mm',
    LLLL: 'dddd, D MMMM YYYY г. HH:mm',
  },
};

// Spanish month and weekday names are lowercase — that is the orthography, not an
// oversight. `L` is day-first like the rest of the Spanish-speaking world, and the long
// forms carry the "de" that Spanish dates require: 18 de octubre de 2026.
const ES: DateLocale = {
  name: 'es',
  months: [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ],
  monthsShort: [
    'ene.',
    'feb.',
    'mar.',
    'abr.',
    'may.',
    'jun.',
    'jul.',
    'ago.',
    'sept.',
    'oct.',
    'nov.',
    'dic.',
  ],
  weekdays: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
  weekdaysShort: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D [de] MMMM [de] YYYY',
    LLL: 'D [de] MMMM [de] YYYY HH:mm',
    LLLL: 'dddd, D [de] MMMM [de] YYYY HH:mm',
  },
};

// Simplified Chinese. The full month NAMES use Chinese numerals — 一月 ("month
// one") through 十二月 — which is the authentic form and the only place in the
// pack set where a non-Arabic numeral system reaches the output. The standard
// L/LL formats keep Arabic digits for the year and day, matching how modern
// China actually writes dates (2024年1月15日); the Chinese-numeral months are
// reachable via the `MMMM` token (e.g. format="YYYY[年]MMMMD[日]"). The literal
// 年/月/日 separators are bracket-escaped like Spanish's [de].
const ZH_CN: DateLocale = {
  name: 'zh-cn',
  months: [
    '一月',
    '二月',
    '三月',
    '四月',
    '五月',
    '六月',
    '七月',
    '八月',
    '九月',
    '十月',
    '十一月',
    '十二月',
  ],
  monthsShort: [
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ],
  weekdays: ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'],
  weekdaysShort: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  formats: {
    L: 'YYYY/MM/DD',
    LL: 'YYYY[年]M[月]D[日]',
    LLL: 'YYYY[年]M[月]D[日] HH:mm',
    LLLL: 'YYYY[年]M[月]D[日]dddd HH:mm',
  },
};

// French month and weekday names are lowercase — that is the orthography, not an
// oversight. Dates are day-first (L = DD/MM/YYYY) like the rest of continental
// Europe, and the long forms are a bare "D MMMM YYYY" with no separators, which
// is how French writes them: 18 octobre 2026, mardi 18 octobre 2026 14:05.
const FR: DateLocale = {
  name: 'fr',
  months: [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre',
  ],
  monthsShort: [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juil.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.',
  ],
  weekdays: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  weekdaysShort: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd D MMMM YYYY HH:mm',
  },
};

// Arabic. Uses the Gregorian month names in their Arabic form (يناير…ديسمبر),
// which are understood across the whole Arab world, rather than the Levantine
// كانون/شباط set. Day-first like the rest of the region. The digits stay ASCII
// (2026, not ٢٠٢٦) — that matches how most official Arabic dates are written and
// keeps them safe for arithmetic; Eastern-Arabic numerals are reachable in data
// via a [٠-٩] generator when a pack wants them. Rendered lines display
// right-to-left; the stored bytes are in logical order.
const AR: DateLocale = {
  name: 'ar',
  months: [
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
  ],
  monthsShort: [
    'يناير',
    'فبراير',
    'مارس',
    'أبريل',
    'مايو',
    'يونيو',
    'يوليو',
    'أغسطس',
    'سبتمبر',
    'أكتوبر',
    'نوفمبر',
    'ديسمبر',
  ],
  weekdays: ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  weekdaysShort: ['أحد', 'إثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'],
  formats: {
    L: 'D/M/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd D MMMM YYYY HH:mm',
  },
};

// Portuguese month and weekday names are lowercase, like Spanish and French.
// Dates are day-first (L = D/M/YYYY) and the long forms use the "de" connector
// (18 de outubro de 2026), matching how Portuguese writes them across both
// European and Brazilian usage.
const PT: DateLocale = {
  name: 'pt',
  months: [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ],
  monthsShort: [
    'jan.',
    'fev.',
    'mar.',
    'abr.',
    'mai.',
    'jun.',
    'jul.',
    'ago.',
    'set.',
    'out.',
    'nov.',
    'dez.',
  ],
  weekdays: [
    'domingo',
    'segunda-feira',
    'terça-feira',
    'quarta-feira',
    'quinta-feira',
    'sexta-feira',
    'sábado',
  ],
  weekdaysShort: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D [de] MMMM [de] YYYY',
    LLL: 'D [de] MMMM [de] YYYY HH:mm',
    LLLL: 'dddd, D [de] MMMM [de] YYYY HH:mm',
  },
};

// German is the one Latin-script locale here whose month and weekday names are
// CAPITALISED — German capitalises all nouns, so "Januar"/"Montag" are correct
// and the lowercase spelling used by French/Spanish/Portuguese would be wrong.
// Dates are day-first with dots (L = DD.MM.YYYY) and the long forms carry the
// ordinal dot after the day: 18. Oktober 2026.
const DE: DateLocale = {
  name: 'de',
  months: [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ],
  monthsShort: [
    'Jan.',
    'Feb.',
    'März',
    'Apr.',
    'Mai',
    'Juni',
    'Juli',
    'Aug.',
    'Sept.',
    'Okt.',
    'Nov.',
    'Dez.',
  ],
  weekdays: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
  weekdaysShort: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
  formats: {
    L: 'DD.MM.YYYY',
    LL: 'D. MMMM YYYY',
    LLL: 'D. MMMM YYYY HH:mm',
    LLLL: 'dddd, D. MMMM YYYY HH:mm',
  },
};

// Italian month and weekday names are lowercase, like Spanish, French and
// Portuguese. Day-first with slashes, and the long forms are a bare
// "D MMMM YYYY" with no connector: 18 ottobre 2026, domenica 18 ottobre 2026.
// Note the grave accents on lunedì…venerdì — they are part of the spelling.
const IT: DateLocale = {
  name: 'it',
  months: [
    'gennaio',
    'febbraio',
    'marzo',
    'aprile',
    'maggio',
    'giugno',
    'luglio',
    'agosto',
    'settembre',
    'ottobre',
    'novembre',
    'dicembre',
  ],
  monthsShort: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  weekdays: ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'],
  weekdaysShort: ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd D MMMM YYYY HH:mm',
  },
};

// Polish, like Russian, inflects the month name inside a date: the standalone
// nominative is "styczeń" but a date reads "18 stycznia 2026". These are the
// genitive forms the formatter needs; the nominative list lives in the data pack
// at pl/date/month.txt. Month and weekday names are lowercase in Polish.
const PL: DateLocale = {
  name: 'pl',
  months: [
    'stycznia',
    'lutego',
    'marca',
    'kwietnia',
    'maja',
    'czerwca',
    'lipca',
    'sierpnia',
    'września',
    'października',
    'listopada',
    'grudnia',
  ],
  monthsShort: ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'],
  weekdays: ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'],
  weekdaysShort: ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'],
  formats: {
    L: 'DD.MM.YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd, D MMMM YYYY HH:mm',
  },
};

// Greek inflects the month inside a date exactly as Russian and Polish do: the
// standalone nominative is "Οκτώβριος" but a date reads "18 Οκτωβρίου 2026".
// These are the genitive forms; the nominative list lives in el/date/month.txt.
const EL: DateLocale = {
  name: 'el',
  months: [
    'Ιανουαρίου',
    'Φεβρουαρίου',
    'Μαρτίου',
    'Απριλίου',
    'Μαΐου',
    'Ιουνίου',
    'Ιουλίου',
    'Αυγούστου',
    'Σεπτεμβρίου',
    'Οκτωβρίου',
    'Νοεμβρίου',
    'Δεκεμβρίου',
  ],
  monthsShort: [
    'Ιαν',
    'Φεβ',
    'Μαρ',
    'Απρ',
    'Μαΐ',
    'Ιουν',
    'Ιουλ',
    'Αυγ',
    'Σεπ',
    'Οκτ',
    'Νοε',
    'Δεκ',
  ],
  weekdays: ['Κυριακή', 'Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή', 'Σάββατο'],
  weekdaysShort: ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd, D MMMM YYYY HH:mm',
  },
};

// Ukrainian, like Russian and Polish, inflects the month name inside a date: the
// standalone nominative is "січень" but a date reads "18 січня 2026". These are
// the genitive forms the formatter needs; the nominative list lives in the data
// pack at uk/date/month.txt. Month and weekday names are lowercase in Ukrainian.
const UK: DateLocale = {
  name: 'uk',
  months: [
    'січня',
    'лютого',
    'березня',
    'квітня',
    'травня',
    'червня',
    'липня',
    'серпня',
    'вересня',
    'жовтня',
    'листопада',
    'грудня',
  ],
  monthsShort: [
    'січ',
    'лют',
    'бер',
    'квіт',
    'трав',
    'черв',
    'лип',
    'серп',
    'вер',
    'жовт',
    'лист',
    'груд',
  ],
  weekdays: ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'],
  weekdaysShort: ['нд', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  formats: {
    L: 'DD.MM.YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd, D MMMM YYYY HH:mm',
  },
};

// Turkish month names do not inflect, so the pack list and this one are the same
// twelve words. They are capitalised: Turkish writes month and weekday names as
// proper nouns.
const TR: DateLocale = {
  name: 'tr',
  months: [
    'Ocak',
    'Şubat',
    'Mart',
    'Nisan',
    'Mayıs',
    'Haziran',
    'Temmuz',
    'Ağustos',
    'Eylül',
    'Ekim',
    'Kasım',
    'Aralık',
  ],
  monthsShort: ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'],
  weekdays: ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'],
  weekdaysShort: ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'],
  formats: {
    L: 'DD.MM.YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd, D MMMM YYYY HH:mm',
  },
};

const LOCALES = new Map<string, DateLocale>([
  ['en', EN],
  ['eng', EN],
  ['ru', RU],
  ['es', ES],
  ['spa', ES],
  ['zh-cn', ZH_CN],
  ['zh', ZH_CN],
  ['fr', FR],
  ['fra', FR],
  ['ar', AR],
  ['ara', AR],
  ['pt', PT],
  ['por', PT],
  ['de', DE],
  ['deu', DE],
  ['it', IT],
  ['ita', IT],
  ['pl', PL],
  ['pol', PL],
  ['el', EL],
  ['ell', EL],
  ['uk', UK],
  ['ukr', UK],
  ['tr', TR],
  ['tur', TR],
]);

export const DATE_LOCALE_NAMES: readonly string[] = [
  'ar',
  'de',
  'el',
  'en',
  'es',
  'fr',
  'it',
  'pl',
  'pt',
  'ru',
  'tr',
  'uk',
  'zh-cn',
];

export function resolveDateLocale(name: string | undefined): DateLocale {
  return LOCALES.get(name ?? 'en') ?? EN;
}

export function isKnownDateLocale(name: string): boolean {
  return LOCALES.has(name);
}
