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
              "декабрь"),
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
          ),
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
              "декабря")
          );

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
              "grudzień"),
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
          ),
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
              "grudnia")
          );

  static final DateFormatter.DateLocale EL =
      new DateFormatter.DateLocale(
          List.of(
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
              "Δεκέμβριος"),
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
          ),
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
              "Δεκεμβρίου")
          );

  // Ukrainian, like Russian and Polish, inflects the month name inside a date: the
  // standalone nominative is "січень" but a date reads "18 січня 2026". These are
  // the genitive forms the formatter needs; the nominative list lives in the data
  // pack at uk/date/month.txt.
  static final DateFormatter.DateLocale UK =
      new DateFormatter.DateLocale(
          List.of(
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
              "грудень"),
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
              "LLLL", "dddd, D MMMM YYYY HH:mm"),
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
              "грудня")
          );

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

  // Japanese names months by number, so MMMM is already "10月" and the long formats use the numeric M with 年/月/日 as literals.
  static final DateFormatter.DateLocale JA =
      new DateFormatter.DateLocale(
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
              "日曜日",
              "月曜日",
              "火曜日",
              "水曜日",
              "木曜日",
              "金曜日",
              "土曜日"),
          List.of(
              "日",
              "月",
              "火",
              "水",
              "木",
              "金",
              "土"),
          Map.of(
              "L", "YYYY/MM/DD",
              "LL", "YYYY[年]M[月]D[日]",
              "LLL", "YYYY[年]M[月]D[日] HH:mm",
              "LLLL", "YYYY[年]M[月]D[日] dddd HH:mm"));

  // Korean names months by number, and a written date reads "2026년 10월 9일" with 년/월/일 as literals.
  static final DateFormatter.DateLocale KO =
      new DateFormatter.DateLocale(
          List.of(
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
              "12월"),
          List.of(
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
              "12월"),
          List.of(
              "일요일",
              "월요일",
              "화요일",
              "수요일",
              "목요일",
              "금요일",
              "토요일"),
          List.of(
              "일",
              "월",
              "화",
              "수",
              "목",
              "금",
              "토"),
          Map.of(
              "L", "YYYY. MM. DD.",
              "LL", "YYYY[년] M[월] D[일]",
              "LLL", "YYYY[년] M[월] D[일] HH:mm",
              "LLLL", "YYYY[년] M[월] D[일] dddd HH:mm"));

  // Dutch writes month and weekday names in lower case, unlike its German neighbour.
  static final DateFormatter.DateLocale NL =
      new DateFormatter.DateLocale(
          List.of(
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
              "december"),
          List.of(
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
              "dec"),
          List.of(
              "zondag",
              "maandag",
              "dinsdag",
              "woensdag",
              "donderdag",
              "vrijdag",
              "zaterdag"),
          List.of(
              "zo",
              "ma",
              "di",
              "wo",
              "do",
              "vr",
              "za"),
          Map.of(
              "L", "DD-MM-YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd D MMMM YYYY HH:mm"));

  // Swedish writes month and weekday names in lower case, and Sweden is an ISO-8601 country: the short date is YYYY-MM-DD.
  static final DateFormatter.DateLocale SV =
      new DateFormatter.DateLocale(
          List.of(
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
              "december"),
          List.of(
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
              "dec"),
          List.of(
              "söndag",
              "måndag",
              "tisdag",
              "onsdag",
              "torsdag",
              "fredag",
              "lördag"),
          List.of(
              "sön",
              "mån",
              "tis",
              "ons",
              "tors",
              "fre",
              "lör"),
          Map.of(
              "L", "YYYY-MM-DD",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd D MMMM YYYY HH:mm"));

  // Hindi names the Gregorian months with borrowed forms and the weekdays after the planets; the week starts on Sunday.
  static final DateFormatter.DateLocale HI =
      new DateFormatter.DateLocale(
          List.of(
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
              "दिसंबर"),
          List.of(
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
              "दिस."),
          List.of(
              "रविवार",
              "सोमवार",
              "मंगलवार",
              "बुधवार",
              "गुरुवार",
              "शुक्रवार",
              "शनिवार"),
          List.of(
              "रवि",
              "सोम",
              "मंगल",
              "बुध",
              "गुरु",
              "शुक्र",
              "शनि"),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd, D MMMM YYYY HH:mm"));

  // Thailand counts years in the Buddhist Era, 543 ahead of the Common Era: 2026 CE is 2569. The formatter does NOT convert — the year a config supplies is the year printed — so a caller that wants the BE year adds 543 itself. The pack says so in its own date descriptions rather than leaving a silent 543-year error.
  static final DateFormatter.DateLocale TH =
      new DateFormatter.DateLocale(
          List.of(
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
              "ธันวาคม"),
          List.of(
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
              "ธ.ค."),
          List.of(
              "วันอาทิตย์",
              "วันจันทร์",
              "วันอังคาร",
              "วันพุธ",
              "วันพฤหัสบดี",
              "วันศุกร์",
              "วันเสาร์"),
          List.of(
              "อา.",
              "จ.",
              "อ.",
              "พ.",
              "พฤ.",
              "ศ.",
              "ส."),
          Map.of(
              "L", "DD/MM/YYYY",
              "LL", "D MMMM YYYY",
              "LLL", "D MMMM YYYY HH:mm",
              "LLLL", "dddd D MMMM YYYY HH:mm"));

  // Czech, like Russian and Polish, inflects the month name inside a date: the standalone nominative is "leden" but a date reads "5. ledna 2026". These are the genitive forms the formatter needs; the nominative list lives in the pack at cs/date/month.txt. Month and weekday names are lower case.
  static final DateFormatter.DateLocale CS =
      new DateFormatter.DateLocale(
          List.of(
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
              "prosinec"),
          List.of(
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
              "pro"),
          List.of(
              "neděle",
              "pondělí",
              "úterý",
              "středa",
              "čtvrtek",
              "pátek",
              "sobota"),
          List.of(
              "ne",
              "po",
              "út",
              "st",
              "čt",
              "pá",
              "so"),
          Map.of(
              "L", "DD.MM.YYYY",
              "LL", "D. MMMM YYYY",
              "LLL", "D. MMMM YYYY HH:mm",
              "LLLL", "dddd D. MMMM YYYY HH:mm"),
          List.of(
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
              "prosince")
          );

  // Hungarian writes a date big-endian — year, month, day — and puts a full stop after EVERY part,
  // the day included: "2026. 10. 09." is a complete date and "2026. 10. 09" is a typo. Month and
  // weekday names are lower case, and the weekday follows the date rather than leading it.
  static final DateFormatter.DateLocale HU =
      new DateFormatter.DateLocale(
          List.of(
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
              "december"),
          List.of(
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
              "dec."),
          List.of(
              "vasárnap",
              "hétfő",
              "kedd",
              "szerda",
              "csütörtök",
              "péntek",
              "szombat"),
          List.of(
              "V",
              "H",
              "K",
              "Sze",
              "Cs",
              "P",
              "Szo"),
          Map.of(
              "L", "YYYY.MM.DD.",
              "LL", "YYYY. MMMM D.",
              "LLL", "YYYY. MMMM D. HH:mm",
              "LLLL", "YYYY. MMMM D., dddd HH:mm"));

  // Finnish, like Czech, inflects the month name inside a date: the month is "tammikuu" but the
  // date reads "5. tammikuuta 2026". These are the partitive forms the formatter needs; the
  // nominative list lives in the pack at fi/date/month.txt. The day number keeps a full stop after
  // it because it is an ordinal, and the time separator is a full stop rather than a colon — 14.30.
  static final DateFormatter.DateLocale FI =
      new DateFormatter.DateLocale(
          List.of(
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
              "joulukuu"),
          List.of(
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
              "joulu"),
          List.of(
              "sunnuntai",
              "maanantai",
              "tiistai",
              "keskiviikko",
              "torstai",
              "perjantai",
              "lauantai"),
          List.of(
              "su",
              "ma",
              "ti",
              "ke",
              "to",
              "pe",
              "la"),
          Map.of(
              "L", "D.M.YYYY",
              "LL", "D. MMMM YYYY",
              "LLL", "D. MMMM YYYY HH.mm",
              "LLLL", "dddd D. MMMM YYYY HH.mm"),
          List.of(
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
              "joulukuuta")
          );

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
          Map.entry("vie", VI),
          Map.entry("ja", JA),
          Map.entry("jpn", JA),
          Map.entry("ko", KO),
          Map.entry("kor", KO),
          Map.entry("nl", NL),
          Map.entry("nld", NL),
          Map.entry("sv", SV),
          // CS, TH and HI were defined here and never registered, so `local="cs"`,
          // `local="th"` and `local="hi"` fell through to English month names while
          // NAMES below advertised all three as supported — a config asking for a
          // Czech date silently got an English one. NAMES also omitted "vi", which
          // has worked since it was added.
          Map.entry("cs", CS),
          Map.entry("ces", CS),
          Map.entry("th", TH),
          Map.entry("hi", HI),
          Map.entry("hu", HU),
          Map.entry("hun", HU),
          Map.entry("fi", FI),
          Map.entry("fin", FI)
      );

  /** The advertised names, for the validator's "did you mean" list. */
  public static final List<String> NAMES =
      List.of(
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
