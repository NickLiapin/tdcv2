/**
 * Fail the build when a documentation example shows data that contradicts itself.
 *
 * The defect this exists for, found on the bindings page and reported by Nick: a
 * config drew a gender independently AND hardcoded `person.female.firstName`, so
 * the documented output read "Мужчина, Полина" — a man with a woman's name. The
 * engine was right; the example was wrong, and it had been wrong in all three
 * locales for as long as the page existed. English and Spanish hid it behind
 * names an eye slides over; only Russian made it obvious.
 *
 * Value drift is explicitly NOT what this checks. Names and numbers are allowed
 * to differ from what today's engine emits — the manifest says so. What is never
 * allowed is output that the shown config could not have produced.
 *
 * Checked, per config block (any fenced block containing `<sequence`):
 *
 *   1. A gendered name generator (`person.male.*` / `person.female.*`) used in a
 *      block that also draws a gender, with nothing tying the two together.
 *      Either tie is accepted, because the DSL has two: `parent="Gender.Male"`
 *      on the sequence, or `<gen if="Gender.Male" …>` branches within one.
 *
 *   2. Both genders drawn but only ONE gendered name source present — the shape
 *      that produced the original bug. A block that draws Male and Female must
 *      offer a male AND a female name source, or it will hand someone the wrong
 *      one.
 *
 * WHAT THIS CANNOT DO. It reads configs. A page that shows only a fragment — the
 * <line> elements, say, with the <sequence> declarations elided — hides its data
 * from this check entirely, and a contradiction living purely in a hand-written
 * terminal block is invisible here. One such defect (women carrying `ivanov`)
 * was found by review, not by this script, and the script would not have caught
 * it however it were written. Automated checking narrows the surface; it does
 * not replace reading the page.
 *
 * Usage:  node webdoc/scripts/audit-example-consistency.mjs
 *         exit 0 = every example is self-consistent; exit 1 = the list
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..');

/**
 * Every gender marker the locales use, as it appears in a `value=` list.
 *
 * The single letters matter: the masks page writes `value="M,F"`, and a first
 * version of this check that looked only for whole words skipped that block
 * entirely — missing a real defect (women carrying `ivanov`, men `petrova`).
 */
const MALE_WORDS = ['Male', 'Мужчина', 'Hombre', 'M', 'М'];
const FEMALE_WORDS = ['Female', 'Женщина', 'Mujer', 'F', 'Ж'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.mdx')) out.push(p);
  }
  return out;
}

/**
 * Every fenced block that holds a TDC config, whatever language it is tagged as.
 *
 * Tagging is NOT the marker: the bindings pages carry their config inside a
 * `configString` in a ```ts block, and the first version of this script looked
 * only at ```xml — so it silently passed the very page whose bug prompted it.
 * `<sequence` is the marker.
 */
function configBlocks(text) {
  const blocks = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!m[1].includes('<sequence')) continue;
    blocks.push({ body: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  return blocks;
}

/** Does this line's own sequence tie it to a gender, by either mechanism? */
function isTied(line, block) {
  if (/\bif\s*=\s*"[^"]*Gender\./.test(line)) return true; // <gen if="Gender.Male" …>
  if (/parent\s*=\s*"[^"]*\./.test(line)) return true; // on the <gen>/<sequence> itself
  // …or on the <sequence> that opens just above it
  const at = block.indexOf(line);
  const before = block.slice(0, at);
  const open = before.lastIndexOf('<sequence');
  if (open === -1) return false;
  const head = before.slice(open);
  return /parent\s*=\s*"/.test(head) && !head.includes('</sequence>');
}

const findings = [];

for (const root of ['docs', join('i18n')]) {
  const dir = join(SITE, root);
  for (const file of walk(dir)) {
    const rel = relative(SITE, file);
    const text = readFileSync(file, 'utf8');

    for (const { body, line } of configBlocks(text)) {
      // Compare against whole LIST ITEMS, not substrings: a bare "M" must not
      // match the M inside "Moscow".
      const listItems = [...body.matchAll(/value="([^"]*)"/g)].flatMap((m) =>
        m[1].split(',').map((v) => v.trim()),
      );
      const drawsMale = listItems.some((v) => MALE_WORDS.includes(v));
      const drawsFemale = listItems.some((v) => FEMALE_WORDS.includes(v));
      const drawsGender = drawsMale && drawsFemale;
      if (!drawsGender) continue;

      const nameLines = body.split('\n').filter((l) => /person\.(male|female)\./.test(l));
      if (nameLines.length === 0) continue;

      const untied = nameLines.filter((l) => !isTied(l, body));
      if (untied.length > 0) {
        findings.push({
          rel,
          line,
          why: 'a gendered name is drawn with no tie to the gender column',
          detail: untied.map((l) => l.trim()).join(' / '),
        });
        continue;
      }

      // Russian surnames carry gender in the word itself, so a plain `value=`
      // list can contradict a gender column without any person.* address in
      // sight — the shape that hid a defect on the masks page from the first
      // version of this check. A list holding BOTH -ov/-ev and -ova/-eva forms
      // beside a gender column is the same bug wearing different clothes.
      const plainLists = [...body.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
      for (const list of plainLists) {
        const items = list.split(',').map((v) => v.trim().toLowerCase());
        const masc = items.filter((v) => /(ов|ев|ин|ский)$/.test(v));
        const fem = items.filter((v) => /(ова|ева|ина|ская)$/.test(v));
        if (masc.length > 0 && fem.length > 0) {
          findings.push({
            rel,
            line,
            why: 'one list mixes masculine and feminine forms beside a gender column',
            detail: `value="${list}"`,
          });
        }
      }

      const hasMaleSource = nameLines.some((l) => l.includes('person.male.'));
      const hasFemaleSource = nameLines.some((l) => l.includes('person.female.'));
      if (!hasMaleSource || !hasFemaleSource) {
        findings.push({
          rel,
          line,
          why: `both genders are drawn but only the ${hasMaleSource ? 'male' : 'female'} name source is present`,
          detail: nameLines.map((l) => l.trim()).join(' / '),
        });
      }
    }
  }
}

if (findings.length > 0) {
  for (const f of findings) {
    console.log(`✗ ${f.rel}:${f.line}`);
    console.log(`    ${f.why}`);
    console.log(`    ${f.detail}`);
  }
  console.log(
    `\n${findings.length} example(s) can produce a row whose name contradicts its gender.\n` +
      'Tie the name to the gender — parent="Gender.Male" on the sequence, or\n' +
      '<gen if="Gender.Male" …> branches inside one — and re-run the config to\n' +
      'refresh the output shown beneath it.',
  );
  process.exit(1);
}
console.log('Every documentation example is self-consistent on gender and names.');
