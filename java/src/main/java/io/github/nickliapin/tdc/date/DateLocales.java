package io.github.nickliapin.tdc.date;

import java.util.List;
import java.util.Map;

/**
 * Month and weekday names, one table per language.
 *
 * <p>Not the platform's locale data. That would make the same seed print different month
 * names on different machines, and it is the one thing the product promises never happens —
 * so the names are carried here, byte for byte the same in every implementation.
 *
 * <p>Several languages inflect the month INSIDE a date: Russian's standalone «октябрь» becomes
 * «18 октября 2026», and Polish and Greek do the same. The tables below hold the form a date
 * needs, not the dictionary form; the nominative list lives in the data pack, where a config
 * asking for a month NAME will find it.
 */
public final class DateLocales {

  private DateLocales() {}

  static final DateFormatter.DateLocale EN =
      new DateFormatter.DateLocale(
          List.of(
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
              "December"),
          List.of(
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
              "Dec"),
          List.of(
              "Sunday",
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday"),
          List.of(
              "Sun",
              "Mon",
              "Tue",
              "Wed",
              "Thu",
              "Fri",
              "Sat"),
          Map.of(
              "L", "MM/DD/YYYY",
              "LL", "MMMM D, YYYY",
              "LLL", "MMMM D, YYYY HH:mm",
              "LLLL", "dddd, MMMM D, YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale RU =
      new DateFormatter.DateLocale(
          List.of(
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
              "декабря"),
          List.of(
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
              "дек."),
          List.of(
              "воскресенье",
              "понедельник",
              "вторник",
              "среда",
              "четверг",
              "пятница",
              "суббота"),
          List.of(
              "вс",
              "пн",
              "вт",
              "ср",
              "чт",
              "пт",
              "сб"),
          Map.of(
              "L", "DD.MM.YYYY",
              "LL", "D MMMM YYYY г.",
              "LLL", "D MMMM YYYY г. HH:mm",
              "LLLL", "dddd, D MMMM YYYY г. HH:mm"
          ));

  static final DateFormatter.DateLocale ES =
      new DateFormatter.DateLocale(
          List.of(
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
              "diciembre"),
          List.of(
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
              "dic."),
          List.of(
              "domingo",
              "lunes",
              "martes",
              "miércoles",
              "jueves",
              "viernes",
              "sábado"),
          List.of(
              "dom",
              "lun",
              "mar",
              "mié",
              "jue",
              "vie",
              "sáb"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D [de] MMMM [de] YYYY",
              "LLL", "D [de] MMMM [de] YYYY HH:mm",
              "LLLL", "dddd, D [de] MMMM [de] YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale ZH_CN =
      new DateFormatter.DateLocale(
          List.of(
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
              "十二月"),
          List.of(
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
              "12月"),
          List.of(
              "星期日",
              "星期一",
              "星期二",
              "星期三",
              "星期四",
              "星期五",
              "星期六"),
          List.of(
              "周日",
              "周一",
              "周二",
              "周三",
              "周四",
              "周五",
              "周六"),
          Map.of(
              "L", "YYYY/MM/DD",
              "LL", "YYYY[年]M[月]D[日]",
              "LLL", "YYYY[年]M[月]D[日] HH:mm",
              "LLLL", "YYYY[年]M[月]D[日]dddd HH:mm"
          ));

  static final DateFormatter.DateLocale FR =
      new DateFormatter.DateLocale(
          List.of(
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
              "décembre"),
          List.of(
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
              "déc."),
          List.of(
              "dimanche",
              "lundi",
              "mardi",
              "mercredi",
              "jeudi",
              "vendredi",
              "samedi"),
          List.of(
              "dim.",
              "lun.",
              "mar.",
              "mer.",
              "jeu.",
              "ven.",
              "sam."),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd D MMMM YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale AR =
      new DateFormatter.DateLocale(
          List.of(
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
              "ديسمبر"),
          List.of(
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
              "ديسمبر"),
          List.of(
              "الأحد",
              "الإثنين",
              "الثلاثاء",
              "الأربعاء",
              "الخميس",
              "الجمعة",
              "السبت"),
          List.of(
              "أحد",
              "إثنين",
              "ثلاثاء",
              "أربعاء",
              "خميس",
              "جمعة",
              "سبت"),
          Map.of(
              "L", "D/M/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd D MMMM YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale PT =
      new DateFormatter.DateLocale(
          List.of(
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
              "dezembro"),
          List.of(
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
              "dez."),
          List.of(
              "domingo",
              "segunda-feira",
              "terça-feira",
              "quarta-feira",
              "quinta-feira",
              "sexta-feira",
              "sábado"),
          List.of(
              "dom",
              "seg",
              "ter",
              "qua",
              "qui",
              "sex",
              "sáb"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D [de] MMMM [de] YYYY",
              "LLL", "D [de] MMMM [de] YYYY HH:mm",
              "LLLL", "dddd, D [de] MMMM [de] YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale DE =
      new DateFormatter.DateLocale(
          List.of(
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
              "Dezember"),
          List.of(
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
              "Dez."),
          List.of(
              "Sonntag",
              "Montag",
              "Dienstag",
              "Mittwoch",
              "Donnerstag",
              "Freitag",
              "Samstag"),
          List.of(
              "So",
              "Mo",
              "Di",
              "Mi",
              "Do",
              "Fr",
              "Sa"),
          Map.of(
              "L", "DD.MM.YYYY",
              "LL", "D. MMMM YYYY",
              "LLL", "D. MMMM YYYY HH:mm",
              "LLLL", "dddd, D. MMMM YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale IT =
      new DateFormatter.DateLocale(
          List.of(
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
              "dicembre"),
          List.of(
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
              "dic"),
          List.of(
              "domenica",
              "lunedì",
              "martedì",
              "mercoledì",
              "giovedì",
              "venerdì",
              "sabato"),
          List.of(
              "dom",
              "lun",
              "mar",
              "mer",
              "gio",
              "ven",
              "sab"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd D MMMM YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale PL =
      new DateFormatter.DateLocale(
          List.of(
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
              "grudnia"),
          List.of(
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
              "gru"),
          List.of(
              "niedziela",
              "poniedziałek",
              "wtorek",
              "środa",
              "czwartek",
              "piątek",
              "sobota"),
          List.of(
              "nd",
              "pn",
              "wt",
              "śr",
              "cz",
              "pt",
              "sb"),
          Map.of(
              "L", "DD.MM.YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd, D MMMM YYYY HH:mm"
          ));

  static final DateFormatter.DateLocale EL =
      new DateFormatter.DateLocale(
          List.of(
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
              "Δεκεμβρίου"),
          List.of(
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
              "Δεκ"),
          List.of(
              "Κυριακή",
              "Δευτέρα",
              "Τρίτη",
              "Τετάρτη",
              "Πέμπτη",
              "Παρασκευή",
              "Σάββατο"),
          List.of(
              "Κυρ",
              "Δευ",
              "Τρί",
              "Τετ",
              "Πέμ",
              "Παρ",
              "Σάβ"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd, D MMMM YYYY HH:mm"
          ));

  // Ukrainian, like Russian and Polish, inflects the month name inside a date: the
  // standalone nominative is "січень" but a date reads "18 січня 2026". These are
  // the genitive forms the formatter needs; the nominative list lives in the data
  // pack at uk/date/month.txt.
  static final DateFormatter.DateLocale UK =
      new DateFormatter.DateLocale(
          List.of(
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
              "грудня"),
          List.of(
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
              "груд"),
          List.of(
              "неділя",
              "понеділок",
              "вівторок",
              "середа",
              "четвер",
              "п'ятниця",
              "субота"),
          List.of(
              "нд",
              "пн",
              "вт",
              "ср",
              "чт",
              "пт",
              "сб"),
          Map.of(
              "L", "DD.MM.YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd, D MMMM YYYY HH:mm"));

  // Turkish month names do not inflect, and are capitalised as proper nouns.
  static final DateFormatter.DateLocale TR =
      new DateFormatter.DateLocale(
          List.of(
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
              "Aralık"),
          List.of(
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
              "Ara"),
          List.of(
              "Pazar",
              "Pazartesi",
              "Salı",
              "Çarşamba",
              "Perşembe",
              "Cuma",
              "Cumartesi"),
          List.of(
              "Paz",
              "Pzt",
              "Sal",
              "Çar",
              "Per",
              "Cum",
              "Cmt"),
          Map.of(
              "L", "DD.MM.YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd, D MMMM YYYY HH:mm"));

  // Indonesian month and weekday names do not inflect, and are capitalised.
  static final DateFormatter.DateLocale ID =
      new DateFormatter.DateLocale(
          List.of(
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
              "Desember"),
          List.of(
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
              "Des"),
          List.of(
              "Minggu",
              "Senin",
              "Selasa",
              "Rabu",
              "Kamis",
              "Jumat",
              "Sabtu"),
          List.of(
              "Min",
              "Sen",
              "Sel",
              "Rab",
              "Kam",
              "Jum",
              "Sab"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd, D MMMM YYYY HH:mm"));

  // Vietnamese names months by number — "tháng 10", not a word of its own — and a full date
  // reads "ngày 9 tháng 10 năm 2026", so the long formats carry those three words as literals.
  static final DateFormatter.DateLocale VI =
      new DateFormatter.DateLocale(
          List.of(
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
              "tháng 12"),
          List.of(
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
              "Th12"),
          List.of(
              "Chủ Nhật",
              "Thứ Hai",
              "Thứ Ba",
              "Thứ Tư",
              "Thứ Năm",
              "Thứ Sáu",
              "Thứ Bảy"),
          List.of(
              "CN",
              "T2",
              "T3",
              "T4",
              "T5",
              "T6",
              "T7"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "[ngày] D MMMM [năm] YYYY",
              "LLL", "[ngày] D MMMM [năm] YYYY HH:mm",
              "LLLL", "dddd, [ngày] D MMMM [năm] YYYY HH:mm"));

  private static final Map<String, DateFormatter.DateLocale> BY_NAME =
      Map.ofEntries(
          Map.entry("en", EN),
          Map.entry("eng", EN),
          Map.entry("ru", RU),
          Map.entry("es", ES),
          Map.entry("spa", ES),
          Map.entry("zh-cn", ZH_CN),
          Map.entry("zh", ZH_CN),
          Map.entry("fr", FR),
          Map.entry("fra", FR),
          Map.entry("ar", AR),
          Map.entry("ara", AR),
          Map.entry("pt", PT),
          Map.entry("por", PT),
          Map.entry("de", DE),
          Map.entry("deu", DE),
          Map.entry("it", IT),
          Map.entry("ita", IT),
          Map.entry("pl", PL),
          Map.entry("pol", PL),
          Map.entry("el", EL),
          Map.entry("ell", EL),
          Map.entry("uk", UK),
          Map.entry("ukr", UK),
          Map.entry("tr", TR),
          Map.entry("tur", TR),
          Map.entry("id", ID),
          Map.entry("ind", ID),
          Map.entry("vi", VI),
          Map.entry("vie", VI)
      );

  /** The advertised names, for the validator's "did you mean" list. */
  public static final List<String> NAMES =
      List.of(
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
          "zh-cn");

  /**
   * The named locale, falling back to English.
   *
   * <p>A fallback rather than an error: a config may name a country pack whose language has
   * no date table of its own yet, and refusing to render a date over that would be a worse
   * answer than English month names.
   */
  public static DateFormatter.DateLocale resolve(String name) {
    return BY_NAME.getOrDefault(name == null ? "en" : name, EN);
  }

  public static boolean isKnown(String name) {
    return BY_NAME.containsKey(name);
  }
}
