#!/usr/bin/env node
/**
 * A pack is written in ITS language's script, and in that language's own words.
 *
 * Most locales need no such check: a Polish pack that drifted into Czech would
 * be obvious to anyone glancing at it. Two families here are not obvious at
 * all, because the wrong answer looks exactly like the right one.
 *
 * ── Traditional Chinese (`zh`) ──────────────────────────────────────────────
 *
 * There are two ways to get it wrong and only the first is visible. The first
 * is a leftover Simplified character — 网 where 網 belongs; `locale-script.json`
 * holds every character that exists only in Simplified, derived once from
 * OpenCC so this script needs no dependency at runtime.
 *
 * The second is the one that actually happens. Somebody converts the glyphs, so
 * every character comes out Traditional and the first check passes, and the
 * pack still reads as mainland Chinese because the WORDS were never changed.
 * 軟件 is written in perfectly good Traditional characters and is not what
 * anybody in Taipei calls software; they say 軟體. 周 versus 週 is the case that
 * proves a character test cannot do this job alone: both are ordinary
 * Traditional characters — 周 is a surname and means a cycle — so no converter
 * will ever touch 周日, and it is still the wrong way to write Sunday in Taiwan.
 *
 * ── Sindhi (`sd`) ───────────────────────────────────────────────────────────
 *
 * Sindhi's alphabet is the largest of any Arabic-derived script, 52 letters,
 * and it shares most of them with Urdu — which is the trap, because a Sindhi
 * pack drafted from an Urdu one is unreadable to a Sindhi reader in a way that
 * is invisible to anyone who does not read the script. Six letters separate
 * them and they are common enough that no real Sindhi text avoids all six by
 * accident: Sindhi writes ه where Urdu writes ہ, ي where Urdu writes ی or ے,
 * and ٽ ڊ ڙ where Urdu writes ٹ ڈ ڑ. Any of those in an `sd/` file means the
 * file is Urdu wearing a Sindhi label.
 *
 * ک is deliberately NOT on that list, and the first draft of this guard had it
 * there and was wrong. Sindhi uses BOTH ڪ and ک and they contrast: ڪ is plain
 * k and ک is aspirated kh, so ڪتاب is a book and کٽ is a bed and swapping them
 * changes the word. Urdu's k happens to be written ک too, which makes the
 * letter look diagnostic when it is not — it is the one letter of the set that
 * both languages own.
 *
 * ھ, on the other hand, IS Urdu's and not Sindhi's, and this was settled the
 * hard way against four independent sources: the Sindhi Language Authority's
 * dictionary accepts باهه, لوهه, چانهه and ڳالهه as headwords and returns
 * nothing at all for باه, لوه, چانه or ڳالھ; an SLA journal article on the
 * script runs ه 309 against ھ 42; a Sindhi Wikipedia corpus runs 3845 against
 * 61; and a 3.58-million-character press corpus has سالگرهه 19 times and
 * سالگره never. So Sindhi writes /h/ as ه in every position, aspirate digraphs
 * included (گهر, سمجهڻ), and DOUBLES it word-finally when it is pronounced. A
 * single final ه is right only for a Perso-Arabic loan with a silent -a
 * (شيعه, جزيره) and for the particles به and نه — which is why the fix for a
 * stray ھ is positional and not a character swap.
 *
 *   node data/scripts/check-locale-script.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'packs');

const table = JSON.parse(readFileSync(join(HERE, 'locale-script.json'), 'utf8'));

/**
 * Characters the derived Chinese table flags that this corpus writes on purpose.
 *
 * 蝨 is the louse and is what OpenCC rewrites 虱 to, but Taiwan writes the
 * milkfish 虱目魚 with 虱, on every restaurant sign on the island.
 */
const ZH_ALLOWED = new Set(['虱']);
const ZH_FORBIDDEN = new Set([...table.simplifiedOnly].filter((ch) => !ZH_ALLOWED.has(ch)));

/**
 * Urdu letters that Sindhi replaces with one of its own, and the replacement.
 *
 * ں (noon ghunna) is deliberately absent: Sindhi does use it for nasalisation,
 * so it separates nothing.
 */
const SD_FORBIDDEN = new Map([
  ['ك', 'ڪ'],
  ['ھ', 'ه, doubled to هه when the word ends in a pronounced /h/'],
  ['ہ', 'ه'],
  ['ے', 'ي'],
  ['ی', 'ي'],
  ['ٹ', 'ٽ'],
  ['ڈ', 'ڊ'],
  ['ڑ', 'ڙ'],
]);

/**
 * Mainland words spelled in Traditional characters, and Taiwan's word for the
 * same thing. Every left-hand side survives a glyph conversion untouched.
 *
 * `except` lists longer strings in which the mainland-looking word is correct,
 * and there are two reasons for one. Some are fixed legal terms: Taiwan's Road
 * Traffic Act says 電動自行車 even though a plain bicycle is 腳踏車. And this
 * pack serves Hong Kong and Macau as well as Taiwan — 菠蘿 is Cantonese for
 * pineapple, so 菠蘿包 and 菠蘿油 are the right names for what a Hong Kong tea
 * house sells, and only a bare 菠蘿 in a Taiwanese context is wrong. A third
 * kind is plain substring overlap: 算法 sits inside the correct 演算法.
 */
const ZH_WORDS = [
  { bad: '周日', good: '週日' },
  { bad: '周一', good: '週一' },
  { bad: '周二', good: '週二' },
  { bad: '周末', good: '週末' },
  { bad: '軟件', good: '軟體' },
  { bad: '硬件', good: '硬體' },
  { bad: '網絡', good: '網路' },
  { bad: '數據', good: '資料' },
  { bad: '信息', good: '資訊' },
  { bad: '芯片', good: '晶片' },
  { bad: '質量', good: '品質' },
  { bad: '程序', good: '程式' },
  { bad: '算法', good: '演算法', except: ['演算法'] },
  { bad: '服務器', good: '伺服器' },
  { bad: '內存', good: '記憶體' },
  { bad: '硬盤', good: '硬碟' },
  { bad: '鼠標', good: '滑鼠' },
  { bad: '打印機', good: '印表機' },
  { bad: '視頻', good: '影片' },
  { bad: '博客', good: '部落格' },
  { bad: '項目', good: '專案' },
  { bad: '簡歷', good: '履歷' },
  { bad: '定制', good: '客製' },
  { bad: '自行車', good: '腳踏車', except: ['電動自行車'] },
  { bad: '摩托車', good: '機車' },
  { bad: '出租車', good: '計程車' },
  { bad: '公交車', good: '公車' },
  { bad: '地鐵', good: '捷運', except: ['港鐵'] },
  { bad: '土豆', good: '馬鈴薯' },
  { bad: '菠蘿', good: '鳳梨', except: ['菠蘿包', '菠蘿油'] },
  { bad: '三文魚', good: '鮭魚' },
  { bad: '奶酪', good: '起司' },
  { bad: '知識產權', good: '智慧財產' },
  { bad: '合同', good: '契約' },
  { bad: '人民法院', good: '法院' },
  { bad: '身份證', good: '身分證' },
];

/**
 * Every pack whose `_locale.json` says it is right-to-left.
 *
 * The mixed-script check below applies to all of them rather than to the one
 * that happened to be under construction: the bidi trap is a property of
 * composing RTL text at all, not of any one language.
 */
function rtlLocales() {
  const out = [];
  for (const name of readdirSync(PACKS).sort()) {
    const manifest = join(PACKS, name, '_locale.json');
    try {
      if (!statSync(join(PACKS, name)).isDirectory()) continue;
      if (JSON.parse(readFileSync(manifest, 'utf8')).direction === 'rtl') out.push(name);
    } catch {
      /* not a locale folder, or no manifest */
    }
  }
  return out;
}

/** What to check, per locale that needs checking. */
const RULES = [
  { locale: 'zh', label: "Traditional throughout, in Taiwan's vocabulary", chars: ZH_FORBIDDEN, words: ZH_WORDS },
  { locale: 'sd', label: 'Sindhi throughout, not Urdu', charMap: SD_FORBIDDEN, words: [], noMixedScript: true },
  ...rtlLocales()
    .filter((name) => name !== 'sd')
    .map((locale) => ({ locale, label: 'free of bidi-corrupted words', words: [], noMixedScript: true })),
];

// Arabic, Arabic Supplement, Thaana (Dhivehi) and Hebrew — the RTL scripts this
// corpus ships. `he` and `dv` need their own ranges or the check is vacuous there.
const RTL_LETTER = /[\u0600-\u06FF\u0750-\u077F\u0780-\u07BF\u0590-\u05FF\u08A0-\u08FF]/;
const LATIN = /[A-Za-z]/;

/**
 * A word must not mix a right-to-left script with Latin letters.
 *
 * This is a bidi trap, not a spelling one, and it caught 52 defects in one
 * afternoon that no reader would have seen. Composing right-to-left text in a
 * left-to-right editor, an Arabic letter typed immediately after a Latin
 * character can come out as the Latin letter that looks like it in the visual
 * run — ن arriving as `n`, م as `m` — inside words like سيمينٽ and ڪيمرون. The
 * rendered line looks correct because the shaping engine still joins what is
 * left, and the file is wrong.
 *
 * Whole-Latin values are fine and common: an aircraft type or a platform name
 * is written in Latin everywhere in Pakistan. It is the MIXTURE inside one
 * token that cannot be deliberate.
 */
function mixedScriptTokens(body) {
  const out = [];
  // Split on the Hebrew maqaf and the hyphen as well as on whitespace: an RTL
  // language attaches its one-letter prepositions straight onto a foreign term,
  // and Hebrew's ב־BRCA1 is correct rather than corrupt.
  for (const token of body.split(/[\s,|\u05BE-]+/)) {
    if (token.length === 0) continue;
    if (RTL_LETTER.test(token) && LATIN.test(token)) out.push(token);
  }
  return [...new Set(out)];
}

/** Every file under `root`, depth first. */
function files(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(root);
  return out;
}

/**
 * The lines of a pack file that carry values.
 *
 * The front matter is dropped by POSITION — everything up to the closing `---`
 * — rather than by matching known key prefixes. A long `description:` wraps
 * onto indented continuation lines that begin with no key at all, and a
 * prefix filter reads those as values: `ar/person/gender.txt` explains itself
 * with the example `parent="Gender.ذكر"`, which is Latin and Arabic in one
 * token on purpose and would be reported as corruption.
 */
function values(text) {
  const lines = text.split('\n');
  let start = 0;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close !== -1) start = close + 1;
  }
  return lines.slice(start).filter((line) => line.length > 0);
}

/** True when every occurrence of `bad` in `body` sits inside an allowed word. */
function onlyInExceptions(body, bad, except) {
  let scanned = body;
  for (const allowed of except) scanned = scanned.split(allowed).join('');
  return !scanned.includes(bad);
}

const problems = [];
const checked = [];

for (const rule of RULES) {
  const root = join(PACKS, rule.locale);
  try {
    statSync(root);
  } catch {
    continue;
  }

  let count = 0;
  for (const file of files(root)) {
    if (!file.endsWith('.txt')) continue;
    count += 1;
    const shown = file.slice(PACKS.length + 1);
    const body = values(readFileSync(file, 'utf8')).join('\n');

    if (rule.chars !== undefined) {
      const found = [...new Set([...body].filter((ch) => rule.chars.has(ch)))];
      if (found.length > 0) problems.push(`${shown}: wrong-script character(s) ${found.join(' ')}`);
    }
    if (rule.charMap !== undefined) {
      for (const [bad, good] of rule.charMap) {
        if (body.includes(bad)) problems.push(`${shown}: Urdu letter ${bad}, Sindhi writes ${good}`);
        // The NAME as well as the body. A coherent-child folder names its files
        // after its parent's values, so a wrong letter there is both a wrong
        // spelling and a broken link — `positionBySport/ڪبڈي.txt` shipped once
        // with Urdu's ڈ in the filename, and fixing it meant renaming the file
        // and editing `sportCoherent.txt` in the same breath or the
        // coherent-child guard would break instead.
        if (shown.includes(bad)) {
          problems.push(`${shown}: Urdu letter ${bad} in the FILE NAME, Sindhi writes ${good}`);
        }
      }
    }
    if (rule.noMixedScript === true) {
      const mixed = mixedScriptTokens(body);
      if (mixed.length > 0) {
        problems.push(`${shown}: Latin letters inside right-to-left word(s) ${mixed.slice(0, 4).join(' ')}`);
      }
    }
    for (const { bad, good, except = [] } of rule.words) {
      if (!body.includes(bad)) continue;
      if (onlyInExceptions(body, bad, except)) continue;
      problems.push(`${shown}: wrong-variety word ${bad}, this locale writes ${good}`);
    }
  }
  if (count > 0) checked.push({ locale: rule.locale, label: rule.label, count });
}

if (problems.length > 0) {
  console.error('a pack is written in the wrong script or the wrong variety:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${String(problems.length)} problem(s). A converted glyph is not a translated word, and a ` +
      'shared alphabet is not a shared orthography; fix the letter, or fix the word.',
  );
  process.exit(1);
}

const named = checked.filter((c) => c.label !== 'free of bidi-corrupted words');
const swept = checked.filter((c) => c.label === 'free of bidi-corrupted words');
const lines = named.map((c) => `${c.locale} is ${c.label} (${String(c.count)} files)`);
if (swept.length > 0) {
  const files = swept.reduce((sum, c) => sum + c.count, 0);
  lines.push(
    `${String(swept.length)} more right-to-left pack(s) free of bidi-corrupted words, ` +
      `${String(files)} files: ${swept.map((c) => c.locale).join(', ')}`,
  );
}
console.log(lines.length > 0 ? lines.join('\n') : 'no script-sensitive pack to check');
