/**
 * Derive the Czech feminine surname list from the masculine one.
 *
 * Czech inflects surnames for gender more thoroughly than any of its
 * neighbours. Where Polish changes only the adjectival names — Kowalski /
 * Kowalska, while Nowak stays Nowak — Czech changes very nearly all of them, by
 * appending -ová: Novák / Nováková, Svoboda / Svobodová, Kříž / Křížová. The
 * suffix is applied to foreign surnames too, so a Czech woman married to a Mr
 * Schmidt is Schmidtová. Only two shapes are left alone: the soft adjectival
 * type in -í (Krejčí, Kočí, Dolejší) and the genitive-plural type in -ů (Janů,
 * Petrů, Martinů), which name a household rather than a person and therefore
 * have nothing to inflect.
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
 * An ending the rules do not cover is REFUSED rather than guessed. The refusal
 * is not theoretical. Czech has a "fleeting e" that drops out of some surnames
 * and stays in others, and no spelling test separates the two: Němec becomes
 * Němcová but Kadlec becomes Kadlecová; Havel becomes Havlová but Zavřel
 * becomes Zavřelová. Guessing there would put a word that is not a name into
 * the pack, so every -ec and -el surname has to be listed in IRREGULAR by hand.
 *
 *   node data/scripts/build-cs-surnames.mjs           rewrite the feminine list
 *   node data/scripts/build-cs-surnames.mjs --check   fail if it is out of date
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, "..", "packs", "cs", "person");
const MASCULINE = join(PACK, "lastName.txt");
const FEMININE = join(PACK, "female", "lastName.txt");

const DESCRIPTION =
  "Czech female surname — the feminine form parallel to the masculine list, line for line. " +
  "Almost every Czech surname inflects: the default is -ová (Novák → Nováková, Svoboda → Svobodová), " +
  "adjectival surnames swap -ý for -á (Černý → Černá), and surnames in -ek lose the fleeting e " +
  "(Marek → Marková, Vaněk → Vaňková). Only the soft adjectival type in -í (Krejčí, Dolejší) and the " +
  "genitive-plural type in -ů (Janů, Martinů) are the same for both genders. " +
  "Derived by data/scripts/build-cs-surnames.mjs — do not edit by hand.";

/**
 * The weight column: a decaying frequency curve, floor(1e6 * rank^-0.1), the
 * same one the masculine list carries. Recomputing it here rather than copying
 * the source column keeps the two files identical row for row by construction.
 */
function weight(rank) {
  return Math.floor(1_000_000 * Math.pow(rank, -0.1));
}

/** Endings whose transformation is regular. Longest first, so -něk beats -ek. */
const RULES = [
  ["ý", "á"], // adjectival: Novotný → Novotná
  ["něk", "ňková"], // the softness moves onto the n: Vaněk → Vaňková
  ["ek", "ková"], // fleeting e drops: Marek → Marková
  ["a", "ová"], // Svoboda → Svobodová
];

/**
 * Surnames whose feminine form is a fact about the word rather than about its
 * ending. Every -ec and -el surname is here, because the fleeting e drops in
 * some and stays in others with nothing in the spelling to tell them apart, and
 * so is every -ěk surname the -něk rule would mangle.
 */
const IRREGULAR = new Map([
  // -ec: the e drops in Němec and Hudec, stays in Kadlec. Same ending, different word.
  ["Adamec", "Adamcová"],
  ["Brabec", "Brabcová"],
  ["Holec", "Holcová"],
  ["Hudec", "Hudcová"],
  ["Kadlec", "Kadlecová"],
  ["Moravec", "Moravcová"],
  ["Němec", "Němcová"],
  ["Vrabec", "Vrabcová"],
  // -el: the e drops in Havel and Kozel, stays in Doležel, Korbel and Daniel.
  ["Havel", "Havlová"],
  ["Kozel", "Kozlová"],
  ["Daniel", "Danielová"],
  ["Doležel", "Doleželová"],
  ["Korbel", "Korbelová"],
  ["Zavřel", "Zavřelová"],
  // -ěk that the -něk rule would mangle into Bezďková.
  ["Bezděk", "Bezděková"],
]);

function feminine(masculine) {
  const irregular = IRREGULAR.get(masculine);
  if (irregular !== undefined) return irregular;
  // The two shapes that name a household rather than a person: nothing inflects.
  if (/[íů]$/u.test(masculine)) return masculine;
  // The fleeting e is a fact about the word, so these must be listed above.
  if (/(ec|el)$/u.test(masculine)) return null;
  // -ěk after anything but n is likewise per-word (Bezděk → Bezděková).
  if (/ěk$/u.test(masculine) && !/něk$/u.test(masculine)) return null;
  // Endings no rule covers at all.
  if (/[eoiyéúě]$/u.test(masculine)) return null;
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
  "locale: cs\n" +
  "---\n" +
  masculine
    .map((m, i) => `${feminine(m)},${String(weight(i + 1))}`)
    .join("\n") +
  "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(FEMININE, "utf8") !== derived) {
    console.error(
      "cs female surnames are out of date — run: node data/scripts/build-cs-surnames.mjs",
    );
    process.exit(1);
  }
  const invariant = masculine.filter((m) => feminine(m) === m).length;
  console.log(
    `cs surnames aligned: ${String(masculine.length)} pairs, ` +
      `${String(masculine.length - invariant)} of them inflected, ${String(invariant)} invariant`,
  );
} else {
  writeFileSync(FEMININE, derived, "utf8");
  console.log(
    `wrote ${String(masculine.length)} feminine surnames ` +
      `(${String(masculine.filter((m) => feminine(m) !== m).length)} inflected)`,
  );
}
