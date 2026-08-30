#!/usr/bin/env node
/**
 * A Chinese pack is written in one script, and in that script's own words.
 *
 * There are two ways to get a Traditional Chinese pack wrong and only the first
 * one is obvious.
 *
 * The obvious one is a leftover Simplified character — 网 where 網 belongs.
 * `chinese-simplified-only.json` holds every character whose Traditional form
 * differs from its Simplified one, derived once from OpenCC's table so this
 * script needs no dependency at runtime, and any of them appearing in `zh/`
 * is a straight error.
 *
 * The second way is the one that actually happens. Somebody converts the
 * glyphs — by tool or by hand — and every character comes out Traditional, so
 * the first check passes, and the pack still reads as mainland Chinese because
 * the WORDS were never changed. 軟件 is written in perfectly good Traditional
 * characters and is not what anybody in Taipei calls software; they say 軟體.
 * Same for 網絡 against 網路, 數據 against 資料, 質量 against 品質, 自行車
 * against 腳踏車, 出租車 against 計程車.
 *
 * 周 versus 週 is the case that proves the two checks have to be separate.
 * Both are ordinary Traditional characters — 周 is a surname and means a cycle
 * — so no script converter will touch 周日, and it is still the wrong way to
 * write Sunday in Taiwan. A character-level check cannot see it. Only a word
 * list can, which is why there is one below and why it is written in
 * Traditional characters: it is looking for text that has already been
 * converted and is still wrong.
 *
 *   node data/scripts/check-chinese-script.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'packs');

const table = JSON.parse(readFileSync(join(HERE, 'chinese-simplified-only.json'), 'utf8'));
const SIMPLIFIED_ONLY = new Set([...table.simplifiedOnly]);

/**
 * Characters the derived table flags that this corpus writes deliberately.
 *
 * 蝨 is the louse and is what OpenCC rewrites 虱 to, but Taiwan writes the
 * milkfish 虱目魚 with 虱 and does so on every restaurant sign on the island.
 */
const ALLOWED_CHARS = new Map([['虱', 'Taiwan writes 虱目魚, the milkfish, with this form']]);
for (const ch of ALLOWED_CHARS.keys()) SIMPLIFIED_ONLY.delete(ch);

/**
 * Mainland words spelled in Traditional characters, and Taiwan's word for the
 * same thing. Every left-hand side survives a glyph conversion untouched.
 *
 * `except` lists longer strings in which the mainland-looking word is correct.
 * Two reasons for that, and both are real. Some are fixed legal terms: Taiwan's
 * Road Traffic Act says 電動自行車 even though a plain bicycle is 腳踏車. And
 * this pack serves Hong Kong and Macau as well as Taiwan — 菠蘿 is Cantonese
 * for pineapple, so 菠蘿包 and 菠蘿油 are the right names for the things a Hong
 * Kong tea house sells, and only a bare 菠蘿 in a Taiwanese context is wrong.
 */
const MAINLAND_WORDS = [
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

/** True when every occurrence of `bad` in `body` sits inside an allowed word. */
function onlyInExceptions(body, bad, except) {
  let scanned = body;
  for (const allowed of except) scanned = scanned.split(allowed).join('');
  return !scanned.includes(bad);
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

/** The lines of a pack file that carry values, without its front matter. */
function values(text) {
  return text
    .split('\n')
    .filter(
      (line) =>
        line.length > 0 &&
        line !== '---' &&
        !line.startsWith('description:') &&
        !line.startsWith('locale:') &&
        !line.startsWith('weighted:') &&
        !line.startsWith('address:'),
    );
}

const problems = [];
let checkedFiles = 0;

const zh = join(PACKS, 'zh');
let present = true;
try {
  statSync(zh);
} catch {
  present = false;
}

if (present) {
  for (const file of files(zh)) {
    if (!file.endsWith('.txt')) continue;
    checkedFiles += 1;
    const shown = file.slice(PACKS.length + 1);
    const body = values(readFileSync(file, 'utf8')).join('\n');

    const simplified = [...new Set([...body].filter((ch) => SIMPLIFIED_ONLY.has(ch)))];
    if (simplified.length > 0) {
      problems.push(`${shown}: Simplified character(s) ${simplified.join(' ')}`);
    }
    for (const { bad, good, except = [] } of MAINLAND_WORDS) {
      if (!body.includes(bad)) continue;
      if (onlyInExceptions(body, bad, except)) continue;
      problems.push(`${shown}: mainland word ${bad}, Taiwan writes ${good}`);
    }
  }
}

if (problems.length > 0) {
  console.error('Traditional Chinese pack carries Simplified script or mainland vocabulary:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${String(problems.length)} problem(s) in ${String(checkedFiles)} file(s). A converted glyph is ` +
      'not a translated word; fix the word.',
  );
  process.exit(1);
}

console.log(
  present
    ? `zh is Traditional throughout, in Taiwan's vocabulary (${String(checkedFiles)} files checked)`
    : 'no zh pack to check',
);
