/**
 * The date locale tables themselves — one entry per language.
 *
 * Split out of `locale.ts` when the sixth `monthsInDate` array pushed that file
 * past the 1000-line ceiling. The registry, the name list and the resolver stay
 * in `locale.ts`; this file is data and nothing else, so a new language is added
 * here and wired there.
 */

export interface DateLocale {
  readonly name: string;
  readonly months: readonly string[];
  /**
   * The month as it is written WITH a day number beside it.
   *
   * Slovak `január` becomes `15. januára`; Finnish `tammikuu` becomes
   * `15. tammikuuta`; Czech, Croatian, Russian and Ukrainian all shift too.
   * Absent when the language does not distinguish the two — English does not,
   * and Hungarian keeps the nominative — in which case `months` is used for
   * both. `renderToken` in `format.ts` documents when each one is chosen.
   */
  readonly monthsInDate?: readonly string[] | undefined;
  readonly monthsShort: readonly string[];
  readonly weekdays: readonly string[];
  readonly weekdaysShort: readonly string[];
  readonly formats: Readonly<Record<'L' | 'LL' | 'LLL' | 'LLLL', string>>;
}

export const EN: DateLocale = {
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

// Spanish month and weekday names are lowercase — that is the orthography, not an
// oversight. `L` is day-first like the rest of the Spanish-speaking world, and the long
// forms carry the "de" that Spanish dates require: 18 de octubre de 2026.
export const ES: DateLocale = {
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
export const ZH_CN: DateLocale = {
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
// Traditional Chinese, the calendar the zh data pack ships with and the one
// zh-tw, zh-hk and zh-mo reach through it. Only one field differs from the
// Simplified table and that is the whole reason this one exists: Taiwan and
// Hong Kong write a short weekday as 週日, with the full 週, where the mainland
// writes 周日. No converter will catch it, because 周 is an ordinary
// Traditional character in its own right — it is a surname and it means a
// cycle — so the two spellings are a usage difference rather than a script one
// and have to be carried as separate tables. Everything else is shared: the
// months are numbered identically in both scripts and 星期日 is written the
// same way on both sides.
export const ZH_TW: DateLocale = {
  name: 'zh-tw',
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
  weekdaysShort: ['週日', '週一', '週二', '週三', '週四', '週五', '週六'],
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
export const FR: DateLocale = {
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
export const AR: DateLocale = {
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
export const PT: DateLocale = {
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
export const DE: DateLocale = {
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
export const IT: DateLocale = {
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

// Turkish month names do not inflect, so the pack list and this one are the same
// twelve words. They are capitalised: Turkish writes month and weekday names as
// proper nouns.
export const TR: DateLocale = {
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

// Indonesian month and weekday names do not inflect, and are capitalised.
export const ID: DateLocale = {
  name: 'id',
  months: [
    'Januari',
    'Februari',
    'Maret',
    'April',
    'Mei',
    'Juni',
    'Juli',
    'Agustus',
    'September',
    'Oktober',
    'November',
    'Desember',
  ],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
  weekdays: ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'],
  weekdaysShort: ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd, D MMMM YYYY HH:mm',
  },
};

// Vietnamese names months by number — "tháng 10", not a word of its own — and a full date
// reads "ngày 9 tháng 10 năm 2026", so the long formats carry those three words as literals.
export const VI: DateLocale = {
  name: 'vi',
  months: [
    'tháng 1',
    'tháng 2',
    'tháng 3',
    'tháng 4',
    'tháng 5',
    'tháng 6',
    'tháng 7',
    'tháng 8',
    'tháng 9',
    'tháng 10',
    'tháng 11',
    'tháng 12',
  ],
  monthsShort: [
    'Th1',
    'Th2',
    'Th3',
    'Th4',
    'Th5',
    'Th6',
    'Th7',
    'Th8',
    'Th9',
    'Th10',
    'Th11',
    'Th12',
  ],
  weekdays: ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'],
  weekdaysShort: ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: '[ngày] D MMMM [năm] YYYY',
    LLL: '[ngày] D MMMM [năm] YYYY HH:mm',
    LLLL: 'dddd, [ngày] D MMMM [năm] YYYY HH:mm',
  },
};

// Japanese names months by number, so MMMM is already "10月" and the long formats use the numeric M with 年/月/日 as literals.
export const JA: DateLocale = {
  name: 'ja',
  months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
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
  weekdays: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  weekdaysShort: ['日', '月', '火', '水', '木', '金', '土'],
  formats: {
    L: 'YYYY/MM/DD',
    LL: 'YYYY[年]M[月]D[日]',
    LLL: 'YYYY[年]M[月]D[日] HH:mm',
    LLLL: 'YYYY[年]M[月]D[日] dddd HH:mm',
  },
};

// Korean names months by number, and a written date reads "2026년 10월 9일" with 년/월/일 as literals.
export const KO: DateLocale = {
  name: 'ko',
  months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  monthsShort: [
    '1월',
    '2월',
    '3월',
    '4월',
    '5월',
    '6월',
    '7월',
    '8월',
    '9월',
    '10월',
    '11월',
    '12월',
  ],
  weekdays: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'],
  weekdaysShort: ['일', '월', '화', '수', '목', '금', '토'],
  formats: {
    L: 'YYYY. MM. DD.',
    LL: 'YYYY[년] M[월] D[일]',
    LLL: 'YYYY[년] M[월] D[일] HH:mm',
    LLLL: 'YYYY[년] M[월] D[일] dddd HH:mm',
  },
};

// Dutch writes month and weekday names in lower case, unlike its German neighbour.
export const NL: DateLocale = {
  name: 'nl',
  months: [
    'januari',
    'februari',
    'maart',
    'april',
    'mei',
    'juni',
    'juli',
    'augustus',
    'september',
    'oktober',
    'november',
    'december',
  ],
  monthsShort: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  weekdays: ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'],
  weekdaysShort: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'],
  formats: {
    L: 'DD-MM-YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd D MMMM YYYY HH:mm',
  },
};

// Swedish writes month and weekday names in lower case, and Sweden is an ISO-8601 country: the short date is YYYY-MM-DD.
export const SV: DateLocale = {
  name: 'sv',
  months: [
    'januari',
    'februari',
    'mars',
    'april',
    'maj',
    'juni',
    'juli',
    'augusti',
    'september',
    'oktober',
    'november',
    'december',
  ],
  monthsShort: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  weekdays: ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'],
  weekdaysShort: ['sön', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör'],
  formats: {
    L: 'YYYY-MM-DD',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd D MMMM YYYY HH:mm',
  },
};

// Hindi names the Gregorian months with borrowed forms and the weekdays after the planets; the week starts on Sunday.
export const HI: DateLocale = {
  name: 'hi',
  months: [
    'जनवरी',
    'फ़रवरी',
    'मार्च',
    'अप्रैल',
    'मई',
    'जून',
    'जुलाई',
    'अगस्त',
    'सितंबर',
    'अक्तूबर',
    'नवंबर',
    'दिसंबर',
  ],
  monthsShort: [
    'जन.',
    'फ़र.',
    'मार्च',
    'अप्रैल',
    'मई',
    'जून',
    'जुल.',
    'अग.',
    'सित.',
    'अक्तू.',
    'नव.',
    'दिस.',
  ],
  weekdays: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
  weekdaysShort: ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd, D MMMM YYYY HH:mm',
  },
};

// Thailand counts years in the Buddhist Era, 543 ahead of the Common Era: 2026 CE is 2569. The formatter does NOT convert — the year a config supplies is the year printed — so a caller that wants the BE year adds 543 itself. The pack says so in its own date descriptions rather than leaving a silent 543-year error.
export const TH: DateLocale = {
  name: 'th',
  months: [
    'มกราคม',
    'กุมภาพันธ์',
    'มีนาคม',
    'เมษายน',
    'พฤษภาคม',
    'มิถุนายน',
    'กรกฎาคม',
    'สิงหาคม',
    'กันยายน',
    'ตุลาคม',
    'พฤศจิกายน',
    'ธันวาคม',
  ],
  monthsShort: [
    'ม.ค.',
    'ก.พ.',
    'มี.ค.',
    'เม.ย.',
    'พ.ค.',
    'มิ.ย.',
    'ก.ค.',
    'ส.ค.',
    'ก.ย.',
    'ต.ค.',
    'พ.ย.',
    'ธ.ค.',
  ],
  weekdays: [
    'วันอาทิตย์',
    'วันจันทร์',
    'วันอังคาร',
    'วันพุธ',
    'วันพฤหัสบดี',
    'วันศุกร์',
    'วันเสาร์',
  ],
  weekdaysShort: ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'],
  formats: {
    L: 'DD/MM/YYYY',
    LL: 'D MMMM YYYY',
    LLL: 'D MMMM YYYY HH:mm',
    LLLL: 'dddd D MMMM YYYY HH:mm',
  },
};

// Hungarian writes a date big-endian — year, month, day — and puts a full stop after EVERY part, the day included: "2026. 10. 09." is a complete date and "2026. 10. 09" is a typo. Month and weekday names are lower case, and the weekday follows the date rather than leading it.
export const HU: DateLocale = {
  name: 'hu',
  months: [
    'január',
    'február',
    'március',
    'április',
    'május',
    'június',
    'július',
    'augusztus',
    'szeptember',
    'október',
    'november',
    'december',
  ],
  monthsShort: [
    'jan.',
    'febr.',
    'márc.',
    'ápr.',
    'máj.',
    'jún.',
    'júl.',
    'aug.',
    'szept.',
    'okt.',
    'nov.',
    'dec.',
  ],
  weekdays: ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'],
  weekdaysShort: ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo'],
  formats: {
    L: 'YYYY.MM.DD.',
    LL: 'YYYY. MMMM D.',
    LLL: 'YYYY. MMMM D. HH:mm',
    LLLL: 'YYYY. MMMM D., dddd HH:mm',
  },
};
