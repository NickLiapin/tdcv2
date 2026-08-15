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

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOURCES = join(ROOT, 'data', 'sources');
const PACKS = join(ROOT, 'data', 'packs');

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
    [800, 'Le tour du monde en quatre-vingts jours', 'Jules Verne'],
    [14155, 'Madame Bovary', 'Gustave Flaubert'],
  ],
  de: [
    [12108, 'Der Tod in Venedig', 'Thomas Mann'],
    [5323, 'Effi Briest', 'Theodor Fontane'],
  ],
  it: [
    [25178, 'Damiano: Storia di una povera famiglia', 'Anton Giulio Barrili'],
    [38720, "L'amore che torna: romanzo", 'Guido da Verona'],
  ],
  es: [[2000, 'Don Quijote', 'Miguel de Cervantes']],
  pt: [[55752, 'Dom Casmurro', 'Machado de Assis']],
  pl: [
    [34079, "Tajemnica Baskerville'ow", 'Arthur Conan Doyle'],
    [6000, 'Ironia Pozorow', 'Waclaw Sieroszewski'],
  ],
};

/** How many of each the pack keeps. The English pack set these numbers. */
const WANT = { sentence: 500, paragraph: 150, word: 400 };

/**
 * Sentence terminators. Arabic and Greek punctuate differently — `؟` and `·` —
 * so the set is not the Latin one everywhere, even though every locale here
 * happens to use the Latin marks today.
 */
const TERMINATOR = /(?<=[.!?…؟])\s+/u;

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
  if (existsSync(cache) && readFileSync(cache, 'utf8').length > 20000) {
    return readFileSync(cache, 'utf8');
  }
  for (const shape of URL_SHAPES) {
    execFileSync('curl', ['-sL', '--max-time', '90', '-o', cache, shape(String(id))], {
      stdio: 'ignore',
    });
    const text = readFileSync(cache, 'utf8');
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
};

/** Everything between the Gutenberg start and end markers, and nothing else. */
function body(text) {
  const start = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(text);
  const end = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(text);
  if (!start || !end) {
    throw new Error('missing a Gutenberg marker — refusing to guess where the licence ends');
  }
  return text.slice(start.index + start[0].length, end.index);
}

function normalise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„«»]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/_/g, '');
}

/** Hard-wrapped prose back into one line per paragraph. */
function paragraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * What makes usable filler. A chapter heading, a table of contents line and a
 * roman numeral are all "text" and none of them is a sentence, so length and
 * shape do the filtering that a human eye would.
 */
const KEEP = {
  sentence: (s) =>
    s.length >= 40 &&
    s.length <= 180 &&
    /[a-zà-öø-ÿа-яёͰ-Ͽ]/iu.test(s) &&
    /[.!?…]$/u.test(s) &&
    !/^[IVXLC]+\.?$/.test(s) &&
    !/[*_[\]{}<>|]/.test(s) &&
    (s.match(/"/g) ?? []).length % 2 === 0,
  paragraph: (p) =>
    p.length >= 200 &&
    p.length <= 700 &&
    !/[*_[\]{}<>|]/.test(p) &&
    (p.match(/"/g) ?? []).length % 2 === 0,
};

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
    const paras = paragraphs(text);
    allParagraphs.push(...paras.filter(KEEP.paragraph));
    for (const p of paras) {
      allSentences.push(...p.split(TERMINATOR).map((s) => s.trim()).filter(KEEP.sentence));
    }
  }

  const uniqueSentences = [...new Set(allSentences)];
  const uniqueParagraphs = [...new Set(allParagraphs)];

  const dir = join(SOURCES, locale, 'text');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sentences.txt'), uniqueSentences.join('\n') + '\n', 'utf8');
  writeFileSync(join(dir, 'paragraphs.txt'), uniqueParagraphs.join('\n') + '\n', 'utf8');
  writeFileSync(
    join(dir, 'README.md'),
    `# ${locale} text corpus — provenance\n\n` +
      'Filler text for posts, reviews, bios, notes — any field that needs plausible\n' +
      `prose in ${locale}.\n\n## Source\n\n` +
      'All text is **public domain**, from [Project Gutenberg](https://www.gutenberg.org).\n' +
      'The Gutenberg header and licence footer are stripped; only the public-domain body\n' +
      'is kept. Quotes and dashes are normalised to ASCII.\n\n' +
      '| Gutenberg id | title | author |\n| --- | --- | --- |\n' +
      books.map(([id, title, author]) => `| ${String(id)} | ${title} | ${author} |`).join('\n') +
      '\n\n## Files\n\n' +
      `- \`sentences.txt\` — ${String(uniqueSentences.length)} sentences\n` +
      `- \`paragraphs.txt\` — ${String(uniqueParagraphs.length)} paragraphs\n\n` +
      'Rebuild with `node data/scripts/build-text-corpus.mjs --locale ' +
      `${locale}\`. The raw books are not committed.\n`,
    'utf8',
  );

  writePack(locale, uniqueSentences, uniqueParagraphs);
  return { sentences: uniqueSentences.length, paragraphs: uniqueParagraphs.length };
}

function writePack(locale, sentences, paragraphs_) {
  const dir = join(PACKS, locale, 'text');
  mkdirSync(dir, { recursive: true });
  const chosen = spread(sentences, WANT.sentence);
  writeFileSync(
    join(dir, 'sentence.txt'),
    header(
      `${locale} filler sentences from public-domain books (Project Gutenberg); see data/sources/${locale}/text/README.md`,
      locale,
    ) + chosen.join('\n') + '\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'paragraph.txt'),
    header(
      `${locale} filler paragraphs from public-domain books (Project Gutenberg); see data/sources/${locale}/text/README.md`,
      locale,
    ) + spread(paragraphs_, WANT.paragraph).join('\n') + '\n',
    'utf8',
  );
  writeFileSync(
    join(dir, 'word.txt'),
    header(
      `Common ${locale} words (content words by frequency from the filler corpus), for slugs, usernames, tags`,
      locale,
    ) + words(chosen).slice(0, WANT.word).join('\n') + '\n',
    'utf8',
  );
}

/**
 * The SOURCE corpora are plain line-per-item files with no front matter — unlike
 * the pack files, which carry a header. Reading them with the pack reader gives
 * an empty list and a rebuild that "differs" from everything, which is what the
 * first --check reported for all seven locales.
 */
function values(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const argv = process.argv.slice(2);
const locales = argv.includes('--all')
  ? Object.keys(BOOKS)
  : argv.includes('--locale')
    ? [argv[argv.indexOf('--locale') + 1]]
    : Object.keys(BOOKS);

if (argv.includes('--check')) {
  // The sources are committed; the packs are derived from them. Rebuilding the
  // packs from the committed sources must not change a byte.
  let bad = 0;
  for (const locale of locales) {
    const dir = join(SOURCES, locale, 'text');
    if (!existsSync(join(dir, 'sentences.txt'))) continue;
    const before = ['sentence', 'paragraph', 'word'].map((n) =>
      readFileSync(join(PACKS, locale, 'text', `${n}.txt`), 'utf8'),
    );
    writePack(locale, values(join(dir, 'sentences.txt')), values(join(dir, 'paragraphs.txt')));
    const after = ['sentence', 'paragraph', 'word'].map((n) =>
      readFileSync(join(PACKS, locale, 'text', `${n}.txt`), 'utf8'),
    );
    if (before.some((t, i) => t !== after[i])) {
      console.error(`${locale}: text pack does not match its source corpus`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  console.log(`text corpora match their sources (${String(locales.length)} locales)`);
} else {
  for (const locale of locales) {
    const n = buildLocale(locale);
    console.log(`  ${locale}: ${String(n.sentences)} sentences, ${String(n.paragraphs)} paragraphs`);
  }
}
