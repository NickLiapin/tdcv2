/**
 * Derive the Slovak feminine surname list from the masculine one.
 *
 * Slovak inflects surnames for gender as thoroughly as Czech: the default is
 * -ová on whatever the masculine form is (Kováč / Kováčová, Horváth /
 * Horváthová, Novák / Nováková), a surname ending in a vowel drops it first
 * (Varga / Vargová, Danko / Danková), and an adjectival surname swaps its
 * ending for -á (Novotný / Novotná, Čierny / Čierna). The suffix goes on
 * Hungarian, Rusyn and Roma surnames too, because their bearers are Slovak
 * citizens registered under Slovak naming law: Nagy / Nagyová, Tóth / Tóthová,
 * Szabó / Szabóová. Slovak law does let a woman of a national minority register
 * the plain form without -ová, so the derived list is the majority spelling
 * rather than the only lawful one — that is a fact about the register, not
 * about the language, and a config wanting the plain form should draw from
 * person/lastName instead.
 *
 * The two files must stay ALIGNED LINE FOR LINE, because a config that draws a
 * surname by gender reads the same row index from both. Line 40 of
 * `person/lastName.txt` and line 40 of `person/female/lastName.txt` have to be
 * the same family, or a generated household ends up with a husband and wife
 * whose surnames are unrelated. Maintaining that by hand across several hundred
 * rows is exactly the kind of promise that quietly stops being true, so the
 * feminine list is not maintained at all: it is derived, and this script is the
 * derivation.
 *
 * WHERE SLOVAK PARTS COMPANY WITH CZECH, and the reason this is not
 * build-cs-surnames.mjs with the locale changed:
 *
 *   - A surname in -ek KEEPS its e. Slovak Bartek → Barteková, Marek →
 *     Mareková, Zúbek → Zúbeková. Czech drops it: Marek → Marková. Running the
 *     Czech rule over a Slovak list would silently produce Bartková for a
 *     woman whose name is Barteková.
 *   - There is no -ů type at all. The Czech genitive-plural surnames (Janů,
 *     Martinů) do not exist in Slovak, so the only invariant shape left is the
 *     soft adjectival -í (Krajčí).
 *   - Slovak adjectival surnames may end in plain -y rather than -ý, because
 *     the rhythmic law shortens an ending that follows a long syllable: čierny,
 *     biely. Those look exactly like the Hungarian surnames in -y (Nagy,
 *     Buday), which take -ová instead. Nothing in the spelling separates the
 *     two, so both are listed in IRREGULAR by hand.
 *
 * An ending the rules do not cover is REFUSED rather than guessed. The refusal
 * is not theoretical: Slovak has a fleeting e that drops out of some stems and
 * stays in others, with no spelling test between them — Nemec becomes Nemcová
 * but Kadlec becomes Kadlecová, and Heger becomes Hegerová while Uher becomes
 * Uhrová. Guessing there would put a word that is not a name into the pack, so
 * every -ec, -el and -er surname has to be listed in IRREGULAR by hand.
 *
 *   node data/scripts/build-sk-surnames.mjs           rewrite the feminine list
 *   node data/scripts/build-sk-surnames.mjs --check   fail if it is out of date
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "..", "packs", "sk", "person");
const MASCULINE = join(PACK, "lastName.txt");
const FEMININE = join(PACK, "female", "lastName.txt");

const DESCRIPTION =
  "Slovak female surname — the feminine form parallel to the masculine list, line for line. " +
  "Almost every Slovak surname inflects: the default is -ová (Kováč → Kováčová, Horváth → Horváthová), " +
  "a surname ending in a vowel drops it first (Varga → Vargová, Danko → Danková), and adjectival surnames " +
  "swap their ending for -á (Novotný → Novotná, Čierny → Čierna). Unlike Czech, a surname in -ek KEEPS its e " +
  "(Bartek → Barteková, Marek → Mareková, not Bartková / Marková). Hungarian surnames take the suffix too " +
  "(Nagy → Nagyová, Szabó → Szabóová), though Slovak law permits a woman of a national minority to register " +
  "the plain form instead — for that, draw person/lastName. Only the soft adjectival type in -í (Krajčí) is " +
  "the same for both genders. Derived by data/scripts/build-sk-surnames.mjs — do not edit by hand.";

/**
 * The weight column: a decaying frequency curve, floor(1e6 * rank^-0.1), the
 * same one the masculine list carries. Recomputing it here rather than copying
 * the source column keeps the two files identical row for row by construction.
 */
function weight(rank) {
  return Math.floor(1_000_000 * Math.pow(rank, -0.1));
}

/**
 * Endings whose transformation is regular. Longest first.
 *
 * Note what is NOT here: no -ek rule. Slovak keeps the fleeting e in -ek, so
 * those names fall through to the default and gain a plain -ová. That absence
 * is the single biggest difference from the Czech script.
 */
const RULES = [
  ["ý", "á"], // adjectival: Novotný → Novotná
  ["a", "ová"], // Varga → Vargová, Chalupka → Chalupková
  ["o", "ová"], // Danko → Danková, Botto → Bottová
];

/**
 * Surnames whose feminine form is a fact about the word rather than about its
 * ending.
 *
 * Three groups live here. Every -ec and -er surname, because the fleeting e
 * drops in some and stays in others with nothing in the spelling to tell them
 * apart. The adjectival surnames that end in plain -y through the rhythmic law,
 * which look identical to the Hungarian ones. And Szabó, whose final long ó is
 * kept and simply carries the suffix.
 */
const IRREGULAR = new Map([
  // -ec: the e drops in Nemec, stays in Kadlec. Same ending, different word.
  ["Adamec", "Adamcová"],
  ["Chovanec", "Chovancová"],
  ["Jakubec", "Jakubcová"],
  ["Kadlec", "Kadlecová"],
  ["Nemec", "Nemcová"],
  // -er: the e stays in all of these, but it drops in Uher → Uhrová, so the
  // ending cannot be made a rule.
  ["Cíger", "Cígerová"],
  ["Demeter", "Demeterová"],
  ["Drucker", "Druckerová"],
  ["Heger", "Hegerová"],
  ["Kroner", "Kronerová"],
  ["Lichner", "Lichnerová"],
  ["Majer", "Majerová"],
  ["Melicher", "Melicherová"],
  ["Švantner", "Švantnerová"],
  // Adjectival, shortened to plain -y by the rhythmic law: these behave like -ý.
  ["Biely", "Biela"],
  ["Čierny", "Čierna"],
  // Hungarian, ending in plain -y or in -ó: these take the suffix unchanged.
  ["Buday", "Budayová"],
  ["Nagy", "Nagyová"],
  ["Szabó", "Szabóová"],
]);

function feminine(masculine) {
  const irregular = IRREGULAR.get(masculine);
  if (irregular !== undefined) return irregular;
  // The soft adjectival type: nothing inflects. Slovak has no -ů type at all.
  if (/í$/u.test(masculine)) return masculine;
  // The fleeting e is a fact about the word, so these must be listed above.
  if (/(ec|el|er)$/u.test(masculine)) return null;
  // Plain -y is ambiguous between adjectival and Hungarian — list it above.
  if (/y$/u.test(masculine)) return null;
  // Endings no rule covers at all.
  if (/[eiuáéíóúôäû]$/u.test(masculine)) return null;
  for (const [from, to] of RULES) {
    if (masculine.endsWith(from)) return masculine.slice(0, -from.length) + to;
  }
  return masculine + "ová";
}

/** Values of a pack list file, with the weight column stripped. */
function values(file) {
  const text = readFileSync(file, "utf8");
  const body = text.startsWith("---") ? (text.split(/^---$/m)[2] ?? "") : text;
  return body
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(",")[0] ?? s);
}

const masculine = values(MASCULINE);
const refused = masculine.filter((m) => feminine(m) === null);
if (refused.length > 0) {
  console.error(
    `${String(refused.length)} masculine surname(s) have an ending no rule covers:\n` +
      refused.map((m) => `  ${m}`).join("\n") +
      "\n\nList each one in IRREGULAR with its real feminine form, or add the ending to RULES " +
      "if the transformation is genuinely regular. Do not guess.",
  );
  process.exit(1);
}

const derived =
  "---\n" +
  `description: ${DESCRIPTION}\n` +
  "weighted: true\n" +
  "locale: sk\n" +
  "---\n" +
  masculine
    .map((m, i) => `${feminine(m)},${String(weight(i + 1))}`)
    .join("\n") +
  "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(FEMININE, "utf8") !== derived) {
    console.error(
      "sk female surnames are out of date — run: node data/scripts/build-sk-surnames.mjs",
    );
    process.exit(1);
  }
  const invariant = masculine.filter((m) => feminine(m) === m).length;
  console.log(
    `sk surnames aligned: ${String(masculine.length)} pairs, ` +
      `${String(masculine.length - invariant)} of them inflected, ${String(invariant)} invariant`,
  );
} else {
  writeFileSync(FEMININE, derived, "utf8");
  console.log(
    `wrote ${String(masculine.length)} feminine surnames ` +
      `(${String(masculine.filter((m) => feminine(m) !== m).length)} inflected)`,
  );
}
