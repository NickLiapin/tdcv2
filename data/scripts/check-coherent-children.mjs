#!/usr/bin/env node
/**
 * Every value of a coherent parent list must have a child file.
 *
 * A folder named `<thing>By<Key>` holds one file per VALUE of the parent list
 * beside it, and a config reads it by interpolating the parent's value into the
 * address: `<gen type="template" value="geo.capitalByCountry.${{Country}}"/>`.
 * A parent value with no file behind it therefore does not fail at check time
 * and does not fail on row one — it fails on whatever row happens to draw that
 * value, halfway through a run, with "resolved to unknown address".
 *
 * Measured when this check was written: `jv/geo` listed 73 countries and shipped
 * 44 children, so a 300-row Javanese run died on `Suriah`; `ru/geo` had five
 * children — Бангладеш, Пакистан, Нигерия, Сингапур, Новая Зеландия — that no
 * parent value could reach. Fifty-six of the fifty-eight locales carrying that
 * folder matched exactly, which is what made the two visible at all.
 *
 * The parent is `<key>Coherent.txt` when it exists and `<key>.txt` otherwise.
 * That distinction is the contract, not a quirk: `medical/specialty.txt` lists
 * every specialty a country recognises, while `medical/specialtyCoherent.txt`
 * lists the subset this pack ships diagnoses for. A weighted list carries
 * `value,weight` and only the value names the child.
 *
 *   node data/scripts/check-coherent-children.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'packs');

/** A pack file's values, with a weighted list's `,weight` tail removed. */
function values(file) {
  const text = readFileSync(file, 'utf8');
  let body = text;
  let weighted = false;
  if (text.startsWith('---')) {
    const parts = text.split('---');
    if (parts.length >= 3) {
      weighted = /^\s*weighted:\s*true\s*$/m.test(parts[1]);
      body = parts.slice(2).join('---');
    }
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (weighted && line.includes(',') ? line.slice(0, line.lastIndexOf(',')).trim() : line));
}

/** Every directory under `root`, depth first. */
function directories(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        out.push(path);
        walk(path);
      }
    }
  };
  walk(root);
  return out;
}

const problems = [];
let checked = 0;

for (const dir of directories(PACKS)) {
  const name = basename(dir);
  const at = name.indexOf('By');
  if (at <= 0) continue;
  const key = name.slice(at + 2);
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  const parent = [join(dir, '..', `${lower}Coherent.txt`), join(dir, '..', `${lower}.txt`)].find(
    (candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
  );
  // A folder whose parent lives elsewhere (the config names the address, not a
  // convention) cannot be checked from here; `ne/person/lastNameByGroup` is fed
  // by `surnameGroup.txt` and is the only one in the corpus.
  if (!parent) continue;
  checked += 1;
  const expected = new Set(values(parent));
  const present = new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith('.txt') || f.endsWith('.tdc'))
      .map((f) => f.replace(/\.(txt|tdc)$/, '')),
  );
  const missing = [...expected].filter((v) => !present.has(v));
  const orphan = [...present].filter((v) => !expected.has(v));
  const where = dir.slice(PACKS.length + 1);
  if (missing.length > 0) {
    problems.push(
      `${where}: ${String(missing.length)} parent value(s) with no child file — ` +
        `a run drawing one of them dies mid-way: ${missing.slice(0, 5).join(', ')}` +
        (missing.length > 5 ? ', …' : ''),
    );
  }
  if (orphan.length > 0) {
    problems.push(
      `${where}: ${String(orphan.length)} child file(s) no parent value can reach: ` +
        `${orphan.slice(0, 5).join(', ')}${orphan.length > 5 ? ', …' : ''}`,
    );
  }
}

if (problems.length > 0) {
  console.error('coherent-child folders that do not match their parent list:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${String(problems.length)} problem(s) in ${String(checked)} folders. Write the missing ` +
      'children, or add the orphans to the parent list.',
  );
  process.exit(1);
}

console.log(`every coherent-child folder matches its parent list (${String(checked)} checked)`);
