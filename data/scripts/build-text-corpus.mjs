/**
 * Build the filler-text corpus for a locale from public-domain books.
 *
 * `text.sentence` and `text.paragraph` are the "lorem ipsum" of this project,
 * except made of real prose so the result reads like a language rather than like
 * Latin. English was built this way by hand from Project Gutenberg; this is the
 * same recipe written down, so the other locales do not each get their own
 * private method.
 *
 * The pipeline, per locale:
 *
 *   1. download the books named in BOOKS, from gutenberg.org
 *   2. strip the Gutenberg header and licence footer — only public-domain body
 *      text is kept, which is the whole reason the licence permits this
 *   3. normalise quotes and dashes to ASCII, collapse the hard line wrapping
 *   4. split into paragraphs, then paragraphs into sentences
 *   5. keep what makes usable filler and drop the rest (see KEEP)
 *   6. write data/sources/<locale>/text/{sentences,paragraphs}.txt + a README
 *      recording where every line came from
 *   7. write the pack files from those sources
 *
 * The raw books are NOT committed: they are tens of megabytes and the extract is
 * what the pack is built from. Re-running this script re-downloads them.
 *
 *   node data/scripts/build-text-corpus.mjs --locale fr
 *   node data/scripts/build-text-corpus.mjs --all
 *   node data/scripts/build-text-corpus.mjs --check      packs match their sources
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SOURCES = join(ROOT, "data", "sources");
const PACKS = join(ROOT, "data", "packs");

/**
 * Books per locale, chosen for PROSE and for variety of register. Verse is
 * excluded deliberately: a line of Pan Tadeusz is a line of poetry, and filler
 * built from it reads as an oddity rather than as ordinary text.
 *
 * Every id was checked to return that language — Gutenberg ids are not
 * mnemonic, and three of the first guesses came back as a different book in a
 * different language.
 */
const BOOKS = {
  fr: [
    [800, "Le tour du monde en quatre-vingts jours", "Jules Verne"],
    [14155, "Madame Bovary", "Gustave Flaubert"],
  ],
  de: [
    [12108, "Der Tod in Venedig", "Thomas Mann"],
    [5323, "Effi Briest", "Theodor Fontane"],
  ],
  it: [
    [25178, "Damiano: Storia di una povera famiglia", "Anton Giulio Barrili"],
    [38720, "L'amore che torna: romanzo", "Guido da Verona"],
  ],
  es: [[2000, "Don Quijote", "Miguel de Cervantes"]],
  pt: [[55752, "Dom Casmurro", "Machado de Assis"]],
  pl: [
    [34079, "Tajemnica Baskerville'ow", "Arthur Conan Doyle"],
    [6000, "Ironia Pozorow", "Waclaw Sieroszewski"],
  ],
  cs: [
    [13083, "R.U.R.", "Karel Capek"],
    [27960, "Hore dedinu", "Josef Uher"],
    [47754, "Blesky nad Beskydami", "Frantisek Sokol-Tuma"],
  ],
  sv: [
    [57052, "Roda rummet", "August Strindberg"],
    [39147, "Bannlyst", "Selma Lagerlof"],
    [51440, "Valda Berattelser", "Selma Lagerlof"],
  ],
  nl: [
    [11024, "Max Havelaar", "Multatuli"],
    [15975, "Camera Obscura", "Hildebrand"],
    [10819, "De kleine Johannes", "Frederik van Eeden"],
  ],
  ja: [
    [33307, "Yujo", "Saneatsu Mushanokoji"],
    [35327, "Amerika monogatari", "Kafu Nagai"],
    [31757, "Omedetaki hito", "Saneatsu Mushanokoji"],
  ],
  hu: [
    [43777, "Az uj foldesur", "Mor Jokai"],
    [69689, "A Pal-utcai fiuk", "Ferenc Molnar"],
    [40685, "Timar Virgil fia", "Mihaly Babits"],
  ],
  fi: [
    [78018, "Karavaani ja muita juttuja", "Pentti Haanpaa"],
    [78058, "Lintukoto", "Joel Lehtonen"],
    [78096, "Hajamuistelmia pakolaiselamasta", "Aatto Siren"],
  ],
  // Serbian has four public-domain books on Gutenberg, total. The primer is not
  // prose and is left out; these are a novel and a popular-science book, which
  // between them is the whole available corpus rather than a selection from it.
  sr: [
    [11292, "Sekund vecnosti", "Dragutin J. Ilic"],
    [11291, "Kameno doba", "Jovan Zujovic"],
  ],
  // Translations rather than Hebrew originals, and deliberately: the Hebrew
  // originals on Gutenberg are 19th-century Haskalah works written in an ornate
  // biblical register, and filler text lifted from those reads to a modern
  // Hebrew speaker roughly as Wycliffe reads to an English one.
  he: [
    [18291, "Hunger, Book One", "Knut Hamsun"],
    [5139, "Tales", "Carl Ewald"],
  ],
  // One book. Searching Gutenberg for Persian returns "Displaying results 1-1",
  // and this is it — so the corpus is not a selection and cannot be widened
  // without a source other than Gutenberg.
  fa: [[46740, "Five Selected Short Stories", "D. H. Lawrence"]],
  // Gutenberg holds five Romanian books. Four are here; the fifth, 35323
  // "Poezii" by Eminescu, is verse and is excluded by the same rule that keeps
  // verse out of every other locale — a line of poetry is not a sentence and
  // its word order is not the language's.
  ro: [
    [64597, "Nuvele", "I. L. Caragiale"],
    [62916, "Povesti", "Ioan Slavici"],
    [65565, "Tara mea", "Maria, Queen of Romania"],
    [11756, "Creierul, o enigma descifrata", "Dorin Teodor Moisa"],
  ],
  // Six Bulgarian books, three of them prose. The other three — 2790 Botev's
  // poems, 2890 Vazov's "Epopeya na zabravenite", 3433 Slaveykov's "Epicheski
  // pesni" — are verse. A thin corpus, closer to sr (two books) than to nl.
  bg: [
    [2894, "Short Stories", "Hristo Botev"],
    [4909, "Olaf van Geldern", "Pencho Slaveykov"],
    [10752, "Mislite v glavite", "Harry Stojan"],
  ],
};

/**
 * Per-locale overrides for languages the default recipe does not fit.
 *
 * The default assumes a space-separated language punctuated with Latin marks,
 * which is three assumptions at once and Japanese breaks all of them. It ends
 * sentences with 。, writes no spaces between words, and packs far more meaning
 * into a character — a Japanese sentence that reads like a 90-character English
 * one is about 35 characters long, so the default 40-180 window would throw
 * nearly all of them away.
 */
const RULES = {
  ja: {
    terminator: /(?<=[。！？])/u,
    sentence: [15, 70],
    paragraph: [60, 400],
    // These files put one paragraph on one line rather than separating them with
    // a blank line, so the default blank-line split returns either fragments or
    // one 6000-character blob.
    paragraphSplit: /\n/,
    // Japanese writes no spaces between words, so there is nothing to split on
    // and words() has no way to find a word boundary. Left to its own devices it
    // happily returns whole clauses — あゝ暑いと云ひながら店の外へ出て了つた came out
    // as a "word" on the first run — and the file would ship looking plausible
    // to anyone who does not read Japanese. Segmenting it properly needs a
    // morphological analyser, which this script does not have and should not
    // pretend to, so word.txt is refused and maintained by hand instead.
    segmentable: false,
    // Aozora-style ruby: 私《ひそ》か carries the reading inside 《》, and ｜ marks
    // where the annotated run begins. Real Japanese prose has neither, so both
    // come out before anything is measured or kept.
    clean: (t) => t.replace(/《[^》]*》/gu, "").replace(/[｜|]/gu, ""),
    // Japanese prose has no spaces in it, so a "sentence" that contains one is
    // not prose. In practice it is always the colophon — 「日本現代文學全集33
    // 永井荷風集」（第七刷）を底本にした — where the space separates parts of a
    // cited title. The generic apparatus rules cannot see it: nothing is
    // parenthesised and the date is written 昭和四十二年, in kanji, so there is
    // no four-digit year to match. The absence of spaces is the Japanese
    // invariant, and it catches this exactly.
    reject: (s) => /\s/u.test(s),
  },
  he: {
    // Hebrew writes no vowels, so the same sentence is materially SHORTER in
    // characters than its European equivalent — the default 40-character floor
    // reads as a filter on content and works as a filter on orthography, and
    // throws away ordinary Hebrew sentences for being spelled economically.
    sentence: [25, 140],
    paragraph: [140, 600],
    // Strip the vowel points. Modern Hebrew is written unpointed — the rest of
    // the he pack is, and says so — but these books are from a period that
    // pointed an ambiguous word to disambiguate it, and 111 of 150 paragraphs
    // came out carrying at least one. Shipping them would make the filler text
    // the only pointed thing in the pack. Only the combining marks go; maqaf
    // (U+05BE), paseq and sof pasuq are punctuation and stay.
    clean: (t) =>
      t.replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/gu, ""),
  },
  fa: {
    // The file is one block with no blank lines at all \u2014 1433 newlines and not
    // a single paragraph break \u2014 so the default blank-line split returns the
    // whole 134 000-character book as one "paragraph" and the filter drops it.
    paragraphSplit: /\n/,
    // Persian orthography, normalised. This text is typed in the mixed way a
    // lot of Persian on the web is: 1986 Arabic yeh against 5226 Persian yeh,
    // 684 Arabic kaf against 1907 Persian kaf, plus 954 harakat. The rest of
    // the fa pack is checked to contain no Arabic yeh or kaf at all, so an
    // unnormalised corpus would be the one place in the locale where the same
    // letter is written two ways.
    clean: (t) =>
      t
        .replace(/\u064A/gu, "\u06CC")
        .replace(/\u0643/gu, "\u06A9")
        .replace(/[\u064B-\u0652\u0670]/gu, ""),
  },
};
const DEFAULT_RULE = {
  terminator: /(?<=[.!?…؟])\s+/u,
  sentence: [40, 180],
  paragraph: [200, 700],
  paragraphSplit: /\n{2,}/,
  clean: (t) => t,
  segmentable: true,
  /** A locale-specific "this cannot be prose in my language" test. None by default. */
  reject: () => false,
};

/**
 * The rule for a locale: the defaults, with that locale's overrides on top.
 *
 * Merged rather than substituted. `RULES[locale] ?? DEFAULT_RULE` reads as
 * "override what you need", and is not — an entry that set only a sentence
 * length would silently lose the terminator, the paragraph split and `clean`,
 * and the failure is a corpus that comes out empty or unsplit rather than an
 * error anyone can act on. Japanese happened to override every field, so
 * nothing showed this until Hebrew wanted two.
 */
const ruleFor = (locale) => ({ ...DEFAULT_RULE, ...(RULES[locale] ?? {}) });

/** How many of each the pack keeps. The English pack set these numbers. */
const WANT = { sentence: 500, paragraph: 150, word: 400 };

/**
 * Sentence terminators. Arabic and Greek punctuate differently — `؟` and `·` —
 * so the set is not the Latin one everywhere, even though every locale here
 * happens to use the Latin marks today.
 */

/**
 * Gutenberg has no single URL shape. Newer books live under `cache/epub`, older
 * ones under `files`, and asking for the wrong one returns a 6 KB error PAGE
 * with a 200 status — which is why the size floor is here rather than a status
 * check. Four of the first thirteen books came back that way.
 */
const URL_SHAPES = [
  (id) => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
  (id) => `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
  (id) => `https://www.gutenberg.org/files/${id}/${id}.txt`,
];

function fetchBook(id) {
  const cache = join(tmpdir(), `tdc-gutenberg-${String(id)}.txt`);
  if (existsSync(cache) && readFileSync(cache, "utf8").length > 20000) {
    return readFileSync(cache, "utf8");
  }
  for (const shape of URL_SHAPES) {
    execFileSync(
      "curl",
      ["-sL", "--max-time", "90", "-o", cache, shape(String(id))],
      {
        stdio: "ignore",
      },
    );
    const text = readFileSync(cache, "utf8");
    if (text.length > 20000) return text;
  }
  throw new Error(`Gutenberg ${String(id)}: no URL shape returned a book`);
}

/**
 * The letters a locale's prose must actually be made of, and how much of the
 * body has to be them.
 *
 * This gate exists because of what it caught. Gutenberg's record for "Детство"
 * is Russian by title and its plain-text file contains NOT ONE Cyrillic letter —
 * so the extract came out as English licence boilerplate and went straight into
 * a pack that claimed to be Russian filler. A second Russian book turned out to
 * be pre-1918 orthography: `московіи`, `былъ`, `какъ`, which is not the language
 * a `ru` locale promises either. Neither is visible in a line count; both are
 * obvious to this test.
 */
const SCRIPT = {
  fr: /[a-zàâçéèêëîïôûùüÿœ]/i,
  de: /[a-zäöüß]/i,
  it: /[a-zàèéìòù]/i,
  es: /[a-záéíóúñü]/i,
  pt: /[a-zàáâãçéêíóôõú]/i,
  pl: /[a-ząćęłńóśźż]/i,
  ru: /[а-яё]/i,
  nl: /[a-zàäéëïöü]/i,
  sv: /[a-zåäö]/i,
  cs: /[a-záčďéěíňóřšťúůýž]/i,
  ja: /[ぁ-んァ-ヶ一-龯]/u,
  hu: /[a-záéíóöőúüű]/i,
  fi: /[a-zäö]/i,
  // Serbian Cyrillic, not Russian Cyrillic: ђ ј љ њ ћ џ are Serbian letters and
  // ё ъ ы э are not, so the class is the Serbian alphabet rather than the block.
  sr: /[абвгдђежзијклљмнњопрстћуфхцчџш]/i,
  he: /[֐-׿]/u,
  // The Persian alphabet, which is the Arabic one plus پ چ ژ گ and with ک ی in
  // place of ك ي. Broad on purpose: this class is also the book-level gate,
  // which asks whether half the letters in the file are in this script, and the
  // four Persian-only letters are 2.7% of a Persian text — they identify the
  // language and cannot measure the script. Persian-versus-Arabic is settled by
  // the source book and by the stopword list, not here.
  fa: /[ء-يپچژکگی]/u,
  // Romanian uses comma-below s and t (U+0219, U+021B), NOT the Turkish
  // cedilla forms (U+015F, U+0163) that older texts and careless fonts
  // substitute. Both are listed so a Gutenberg scan in the legacy encoding
  // still counts as Romanian script; the pack itself is comma-below only and
  // a separate check enforces that.
  ro: /[a-zăâîșțşţ]/i,
  // Bulgarian Cyrillic, not Russian Cyrillic: ъ is a VOWEL here and is common,
  // while ё ы э are not Bulgarian letters at all. Listing the alphabet rather
  // than the block is what stops a Russian passage scoring as Bulgarian.
  bg: /[абвгдежзийклмнопрстуфхцчшщъьюя]/i,
};

/**
 * Function words, used to spot a sentence that is in the WRONG language.
 *
 * The SCRIPT gate above separates alphabets; it cannot separate two languages
 * that share one. Max Havelaar quotes French at length, and eight French
 * sentences sailed through the Dutch gate untouched — "Le plus rare ensemble de
 * mérites…" came out as the first line of the Dutch filler corpus.
 *
 * The obvious test — require a sentence to contain one of its own language's
 * function words — was tried first and was wrong. It threw away about a
 * thousand perfectly good sentences across the seven Latin-script locales,
 * because short dialogue often contains none of them: "Encore cinq minutes,
 * dit Andrew Stuart." is unimpeachable French with not one word from a
 * 25-item list.
 *
 * So the test is comparative instead, and only fires on positive evidence: a
 * sentence is dropped when it matches ANOTHER language's function words and
 * none of its own. Text that matches neither list is left alone, because
 * matching nothing is not evidence of anything.
 */
/**
 * Gutenberg's own furniture, which sits INSIDE the START/END markers on some
 * books and is therefore not removed by stripping the licence.
 *
 * "Produced by Ronnie Sahlberg, Therese Wright, and the Online Distributed
 * Proofreading Team at http://www.pgdp.net." was the first sentence of the
 * Swedish filler corpus. Once the marker was written down, the same line turned
 * up in de, it, pl and ja too — it had been shipping as prose since the corpus
 * was first built, in every locale whose books carry a credit line.
 *
 * This is not language detection; it is a list of things Project Gutenberg
 * writes and nineteenth-century novelists do not.
 */
const BOILERPLATE =
  /project gutenberg|produced (by|from)|made available by|generously|proofread|pgdp\.net|internet archive|google book|library of|transcriber|updated editions|https?:\/\/|www\.|ebook|e-text|public domain|copyright|scanned|digiti[sz]ed/i;

const STOPWORDS = {
  // English is never a corpus locale. It is here purely as a DETECTOR: Gutenberg
  // credit lines are English, and chasing them one phrase at a time was
  // whack-a-mole — "Produced by…", then "produced from images…", then "Thanks to
  // … for creating plain text from HTML." Listing English once kills the whole
  // class, because an English sentence scores high on English and near zero on
  // whatever language the corpus claims to be.
  en: [
    "the",
    "and",
    "of",
    "to",
    "in",
    "is",
    "for",
    "with",
    "that",
    "this",
    "was",
    "from",
    "by",
    "at",
    "on",
    "as",
    "are",
    "it",
    "be",
    "or",
    "an",
    "have",
    "has",
    "not",
    "but",
    "all",
    "were",
    "been",
    "their",
    "which",
    "thanks",
    "created",
    "creating",
  ],
  fr: [
    "le",
    "la",
    "les",
    "de",
    "des",
    "du",
    "un",
    "une",
    "et",
    "est",
    "que",
    "qui",
    "pas",
    "dans",
    "pour",
    "sur",
    "avec",
    "ne",
    "se",
    "ce",
    "il",
    "elle",
    "nous",
    "vous",
    "au",
    "aux",
    "par",
  ],
  de: [
    "der",
    "die",
    "das",
    "und",
    "ist",
    "nicht",
    "ein",
    "eine",
    "den",
    "dem",
    "des",
    "zu",
    "mit",
    "auf",
    "für",
    "von",
    "sich",
    "er",
    "sie",
    "es",
    "aber",
    "auch",
    "noch",
    "wie",
    "war",
  ],
  it: [
    "il",
    "lo",
    "la",
    "gli",
    "le",
    "di",
    "che",
    "non",
    "un",
    "una",
    "per",
    "con",
    "su",
    "da",
    "del",
    "della",
    "si",
    "è",
    "ma",
    "come",
    "più",
    "anche",
    "sono",
    "era",
  ],
  es: [
    "el",
    "la",
    "los",
    "las",
    "de",
    "que",
    "no",
    "un",
    "una",
    "por",
    "con",
    "su",
    "para",
    "es",
    "se",
    "en",
    "al",
    "del",
    "pero",
    "como",
    "más",
    "ya",
    "muy",
    "era",
    "son",
  ],
  pt: [
    "os",
    "as",
    "de",
    "que",
    "não",
    "um",
    "uma",
    "por",
    "com",
    "para",
    "é",
    "se",
    "em",
    "no",
    "na",
    "do",
    "da",
    "mas",
    "como",
    "mais",
    "já",
    "era",
    "são",
  ],
  pl: [
    "i",
    "w",
    "z",
    "na",
    "nie",
    "to",
    "że",
    "się",
    "do",
    "jak",
    "ale",
    "po",
    "za",
    "od",
    "przez",
    "jest",
    "był",
    "była",
    "być",
    "ma",
    "tylko",
    "już",
    "co",
    "tym",
    "przy",
  ],
  cs: [
    "a",
    "je",
    "se",
    "na",
    "že",
    "v",
    "s",
    "z",
    "do",
    "to",
    "ale",
    "jak",
    "po",
    "za",
    "od",
    "byl",
    "byla",
    "být",
    "má",
    "jen",
    "již",
    "co",
    "tím",
    "při",
    "pro",
    "který",
    "která",
    "tak",
    "když",
    "nebo",
  ],
  sv: [
    "och",
    "att",
    "det",
    "som",
    "en",
    "på",
    "är",
    "av",
    "för",
    "med",
    "till",
    "den",
    "har",
    "de",
    "inte",
    "om",
    "ett",
    "han",
    "men",
    "var",
    "jag",
    "sig",
    "från",
    "vi",
    "så",
    "kan",
    "när",
    "hon",
    "ut",
    "eller",
  ],
  nl: [
    "de",
    "het",
    "een",
    "en",
    "van",
    "is",
    "dat",
    "niet",
    "ik",
    "je",
    "hij",
    "zij",
    "wij",
    "te",
    "op",
    "met",
    "voor",
    "aan",
    "er",
    "om",
    "ook",
    "nog",
    "maar",
    "als",
    "dan",
    "zo",
    "bij",
    "naar",
    "uit",
    "door",
    "hy",
    "zy",
    "wy",
    "my",
    "zyn",
    "altyd",
    "wel",
    "men",
    "zich",
  ],
  hu: [
    "a",
    "az",
    "és",
    "hogy",
    "nem",
    "is",
    "de",
    "egy",
    "van",
    "volt",
    "meg",
    "csak",
    "már",
    "még",
    "el",
    "ki",
    "be",
    "fel",
    "le",
    "mint",
    "vagy",
    "ez",
    "azt",
    "ha",
    "úgy",
    "ott",
    "itt",
    "nagy",
    "minden",
    "amit",
  ],
  fi: [
    "ja",
    "on",
    "ei",
    "se",
    "hän",
    "että",
    "oli",
    "mutta",
    "niin",
    "kuin",
    "sitä",
    "kun",
    "mitä",
    "vain",
    "jo",
    "nyt",
    "myös",
    "hyvin",
    "tai",
    "hänen",
    "sen",
    "tämä",
    "olla",
    "vielä",
    "ovat",
    "joka",
    "hänelle",
    "siitä",
  ],
  sr: [
    "и",
    "је",
    "да",
    "се",
    "не",
    "у",
    "на",
    "за",
    "су",
    "од",
    "али",
    "како",
    "што",
    "по",
    "то",
    "био",
    "била",
    "бити",
    "један",
    "која",
    "који",
    "више",
    "него",
    "кад",
    "сам",
    "све",
    "још",
    "тако",
  ],
  he: [
    "את",
    "של",
    "לא",
    "על",
    "אני",
    "הוא",
    "היא",
    "זה",
    "כי",
    "עם",
    "אל",
    "כל",
    "מה",
    "אם",
    "היה",
    "הם",
    "גם",
    "רק",
    "או",
    "אבל",
    "יש",
    "אין",
    "כמו",
    "אשר",
    "אותו",
    "עוד",
    "כך",
    "אחד",
  ],
  fa: [
    "و",
    "در",
    "به",
    "از",
    "که",
    "این",
    "را",
    "با",
    "است",
    "برای",
    "آن",
    "یک",
    "خود",
    "تا",
    "کرد",
    "شد",
    "می",
    "بود",
    "اما",
    "هم",
    "من",
    "او",
    "ما",
    "چه",
    "نه",
    "هر",
    "یا",
    "بر",
  ],
  // Romanian shares its alphabet with no neighbour, but its Gutenberg texts are
  // old enough to carry French and Latin quotation, so the function words earn
  // their place. "si" and "sa" are listed without diacritics too, because the
  // 1930s printings this corpus draws on often set them bare.
  ro: [
    "de",
    "si",
    "și",
    "la",
    "cu",
    "in",
    "în",
    "un",
    "o",
    "este",
    "care",
    "pe",
    "nu",
    "se",
    "ca",
    "din",
    "sau",
    "pentru",
    "mai",
    "dar",
    "ce",
    "sa",
    "să",
    "al",
    "ale",
    "lui",
    "era",
    "fi",
  ],
  // Bulgarian against Russian is the real work here: the two share most of the
  // alphabet and much of the vocabulary, so the discriminating words are the
  // ones Russian does NOT use this way — "да" before a verb (Bulgarian has no
  // infinitive), "ще" for the future, "като", "си".
  bg: [
    "и",
    "в",
    "на",
    "е",
    "да",
    "се",
    "за",
    "с",
    "от",
    "не",
    "че",
    "по",
    "като",
    "но",
    "си",
    "то",
    "са",
    "ще",
    "а",
    "при",
    "той",
    "тя",
    "този",
    "който",
    "беше",
    "може",
  ],
};

/** Everything between the Gutenberg start and end markers, and nothing else. */
function body(text) {
  const start =
    /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(
      text,
    );
  const end =
    /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(
      text,
    );
  if (!start || !end) {
    throw new Error(
      "missing a Gutenberg marker — refusing to guess where the licence ends",
    );
  }
  return text.slice(start.index + start[0].length, end.index);
}

function normalise(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[–—―]/g, "-")
    .replace(/ /g, " ")
    .replace(/_/g, "");
}

/** Hard-wrapped prose back into one line per paragraph. */
function paragraphs(text, splitOn) {
  return text
    .split(splitOn)
    .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * What makes usable filler. A chapter heading, a table of contents line and a
 * roman numeral are all "text" and none of them is a sentence, so length and
 * shape do the filtering that a human eye would.
 */
/**
 * A book's own front matter, which is not Gutenberg boilerplate and not prose.
 *
 * BOILERPLATE catches what Gutenberg wraps a book IN, and the header strip takes
 * the rest — but a title page, a colophon and a rights notice belong to the book
 * and survive both. They are in the right language and the right script, so
 * every gate above passes them, and they land at the top of the corpus where
 * they are the first thing anyone reads: the Hungarian pack opened with "(A
 * fordítás jogát szerző fenntartja magának)" and the Finnish one with
 * "Helsingissä, Kustannusosakeyhtiö Kansanvalta, 1930."
 *
 * Two shapes, both language-agnostic on purpose — a keyword list per language
 * would be the same whack-a-mole the English boilerplate comment describes:
 *
 *   * a sentence that is WHOLLY parenthesised. Prose does not put a whole
 *     sentence in brackets; a rights line and an editor's aside do.
 *   * a short sentence carrying a bare year. An imprint is a place, a publisher
 *     and a date with no verb between them. Six words is the ceiling, so a real
 *     short sentence that happens to name a year is the only thing at risk, and
 *     losing one of those from filler text costs nothing.
 *
 * Measured over every corpus before it was added: 4 lines out of 6500, all four
 * genuine apparatus, and zero false positives in the nine locales that were
 * already shipping. One of the four was a bibliographic note that had been in
 * the Japanese pack since it was built.
 */
const WHOLLY_PARENTHESISED = /^\s*[([].*[)\]][.!?]?\s*$/u;
const YEAR = /(?:^|[^\d])(1[4-9]\d\d|20[0-2]\d)(?:[^\d]|$)/u;
/**
 * Two or more shouted words in a row: a title page, not a sentence.
 *
 * Romanian was the first corpus whose books carry their imprint as running
 * text, and two lines walked straight through every other filter into
 * `text/sentence.txt` — "Colecție îngrijită de MARIN SIM.-RIMNICEANU Membru
 * cor." and "EDITURA INSTITUTULUI DE ARTE GRAFICE … BUCUREȘTI." Both are
 * grammatical, both are in Romanian, and neither is a sentence anyone would
 * want as filler text.
 *
 * A single shouted word is left alone: real dialogue shouts, and acronyms are
 * ordinary inside prose. It takes two adjacent ones to mean typography. Checked
 * against all 32 locales that ship a corpus before it was added — it matches
 * nothing anywhere else, so it removes exactly what it was written for.
 */
const SHOUTED_RUN = /\p{Lu}{2,}[.\-]?\s+\p{Lu}{2,}/u;

const isApparatus = (s) =>
  WHOLLY_PARENTHESISED.test(s) ||
  SHOUTED_RUN.test(s) ||
  (YEAR.test(s) && (s.match(/\p{L}+/gu) ?? []).length < 7);

function keep(rule, script, locale) {
  const own = STOPWORDS[locale];
  const others = Object.entries(STOPWORDS).filter(([code]) => code !== locale);
  const speaks = (text) => {
    if (own === undefined) return true;
    // Split ON the apostrophe, not across it. French elides — l'existence,
    // n'est, d'être — and a tokenizer that keeps the apostrophe inside the word
    // never sees "est" or "de", so French quotations scored zero against their
    // own language and stayed in the Dutch and Swedish corpora.
    const words = new Set(text.toLowerCase().match(/\p{L}+/gu) ?? []);
    const hits = (list) => list.filter((w) => words.has(w)).length;
    const mine = hits(own);
    const best = Math.max(0, ...others.map(([, list]) => hits(list)));
    // Counting, not a boolean. A single shared word proves nothing: "de" is
    // Dutch AND French, which is how "Le plus rare ensemble de mérites…" was
    // still passing as Dutch after the first attempt. Drop the sentence only
    // when another language is the clearly better explanation.
    return best < mine + 2;
  };
  const [sMin, sMax] = rule.sentence;
  const [pMin, pMax] = rule.paragraph;
  return {
    sentence: (s) =>
      s.length >= sMin &&
      s.length <= sMax &&
      script.test(s) &&
      !BOILERPLATE.test(s) &&
      !isApparatus(s) &&
      !rule.reject(s) &&
      speaks(s) &&
      /[.!?…。！？]$/u.test(s) &&
      !/^[IVXLC]+\.?$/.test(s) &&
      !/[*_[\]{}<>|]/.test(s) &&
      (s.match(/"/g) ?? []).length % 2 === 0 &&
      // Same idea as the quote rule: a sentence split out of the middle of a
      // parenthetical carries a closing bracket with no opener, and reads as
      // debris — "12:te och 9:de), så hade den stått ovanför altaret."
      (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length,
    paragraph: (p) =>
      p.length >= pMin &&
      p.length <= pMax &&
      !BOILERPLATE.test(p) &&
      !isApparatus(p) &&
      !rule.reject(p) &&
      speaks(p) &&
      !/[*_[\]{}<>|]/.test(p) &&
      (p.match(/"/g) ?? []).length % 2 === 0 &&
      (p.match(/\(/g) ?? []).length === (p.match(/\)/g) ?? []).length,
  };
}

/** Content words, longest-first by frequency, for slugs and tags. */
function words(sentences) {
  const count = new Map();
  for (const s of sentences) {
    for (const w of s.toLowerCase().match(/[\p{L}]{4,}/gu) ?? []) {
      count.set(w, (count.get(w) ?? 0) + 1);
    }
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([w]) => w);
}

/** Take evenly across the whole corpus, so one book cannot supply everything. */
function spread(items, want) {
  if (items.length <= want) return items;
  const step = items.length / want;
  return Array.from({ length: want }, (_, i) => items[Math.floor(i * step)]);
}

function header(description, locale) {
  return `---\ndescription: ${description}\nlocale: ${locale}\n---\n`;
}

function buildLocale(locale) {
  const rule = ruleFor(locale);
  const KEEP = keep(rule, SCRIPT[locale], locale);
  const books = BOOKS[locale];
  if (!books) throw new Error(`no books listed for "${locale}"`);

  const allSentences = [];
  const allParagraphs = [];
  for (const [id, title] of books) {
    const text = normalise(body(fetchBook(id)));
    const letters = text.match(/\p{L}/gu) ?? [];
    const native = letters.filter((c) => SCRIPT[locale].test(c)).length;
    if (letters.length < 5000 || native / letters.length < 0.5) {
      throw new Error(
        `Gutenberg ${String(id)} ("${title}") is not ${locale} prose: ` +
          `${String(native)} of ${String(letters.length)} letters match the locale's script`,
      );
    }
    const paras = paragraphs(rule.clean(text), rule.paragraphSplit);
    allParagraphs.push(...paras.filter(KEEP.paragraph));
    for (const p of paras) {
      allSentences.push(
        ...p
          .split(rule.terminator)
          .map((s) => s.trim())
          .filter(KEEP.sentence),
      );
    }
  }

  const uniqueSentences = [...new Set(allSentences)];
  const uniqueParagraphs = [...new Set(allParagraphs)];

  const dir = join(SOURCES, locale, "text");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "sentences.txt"),
    uniqueSentences.join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "paragraphs.txt"),
    uniqueParagraphs.join("\n") + "\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${locale} text corpus — provenance\n\n` +
      "Filler text for posts, reviews, bios, notes — any field that needs plausible\n" +
      `prose in ${locale}.\n\n## Source\n\n` +
      "All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).\n" +
      "The Gutenberg header and licence footer are stripped; only the public-domain body\n" +
      "is kept. Quotes and dashes are normalised to ASCII.\n\n" +
      "| Gutenberg id | title | author |\n| --- | --- | --- |\n" +
      books
        .map(
          ([id, title, author]) => `| ${String(id)} | ${title} | ${author} |`,
        )
        .join("\n") +
      "\n\n## Files\n\n" +
      `- \`sentences.txt\` — ${String(uniqueSentences.length)} sentences\n` +
      `- \`paragraphs.txt\` — ${String(uniqueParagraphs.length)} paragraphs\n\n` +
      "Rebuild with `node data/scripts/build-text-corpus.mjs --locale " +
      `${locale}\`. The raw books are not committed.\n`,
    "utf8",
  );

  writePack(locale, uniqueSentences, uniqueParagraphs);
  return {
    sentences: uniqueSentences.length,
    paragraphs: uniqueParagraphs.length,
  };
}

function writePack(locale, sentences, paragraphs_) {
  const dir = join(PACKS, locale, "text");
  mkdirSync(dir, { recursive: true });
  const chosen = spread(sentences, WANT.sentence);
  writeFileSync(
    join(dir, "sentence.txt"),
    header(
      `${locale} filler sentences from public-domain books (Project Gutenberg); see data/sources/${locale}/text/README.md`,
      locale,
    ) +
      chosen.join("\n") +
      "\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "paragraph.txt"),
    header(
      `${locale} filler paragraphs from public-domain books (Project Gutenberg); see data/sources/${locale}/text/README.md`,
      locale,
    ) +
      spread(paragraphs_, WANT.paragraph).join("\n") +
      "\n",
    "utf8",
  );
  if (ruleFor(locale).segmentable) {
    writeFileSync(
      join(dir, "word.txt"),
      header(
        `Common ${locale} words (content words by frequency from the filler corpus), for slugs, usernames, tags`,
        locale,
      ) +
        words(chosen).slice(0, WANT.word).join("\n") +
        "\n",
      "utf8",
    );
  } else {
    console.log(
      `  ${locale}: word.txt left alone — no word boundaries to split on`,
    );
  }
}

/**
 * The SOURCE corpora are plain line-per-item files with no front matter — unlike
 * the pack files, which carry a header. Reading them with the pack reader gives
 * an empty list and a rebuild that "differs" from everything, which is what the
 * first --check reported for all seven locales.
 */
function values(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

const argv = process.argv.slice(2);
const locales = argv.includes("--all")
  ? Object.keys(BOOKS)
  : argv.includes("--locale")
    ? [argv[argv.indexOf("--locale") + 1]]
    : Object.keys(BOOKS);

if (argv.includes("--check")) {
  // The sources are committed; the packs are derived from them. Rebuilding the
  // packs from the committed sources must not change a byte.
  let bad = 0;
  for (const locale of locales) {
    const dir = join(SOURCES, locale, "text");
    if (!existsSync(join(dir, "sentences.txt"))) continue;
    const before = ["sentence", "paragraph", "word"].map((n) =>
      readFileSync(join(PACKS, locale, "text", `${n}.txt`), "utf8"),
    );
    writePack(
      locale,
      values(join(dir, "sentences.txt")),
      values(join(dir, "paragraphs.txt")),
    );
    const after = ["sentence", "paragraph", "word"].map((n) =>
      readFileSync(join(PACKS, locale, "text", `${n}.txt`), "utf8"),
    );
    if (before.some((t, i) => t !== after[i])) {
      console.error(`${locale}: text pack does not match its source corpus`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  console.log(
    `text corpora match their sources (${String(locales.length)} locales)`,
  );
} else {
  for (const locale of locales) {
    const n = buildLocale(locale);
    console.log(
      `  ${locale}: ${String(n.sentences)} sentences, ${String(n.paragraphs)} paragraphs`,
    );
  }
}
