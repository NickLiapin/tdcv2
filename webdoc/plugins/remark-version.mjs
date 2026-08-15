/**
 * Put the released version into the pages at build time, so no page carries it.
 *
 * The install pages tell people exactly what to type: a Maven coordinate, a
 * Gradle line, a `curl` for a jar whose filename contains the number, a table of
 * five registries. Every one of those used to be a literal, and every one of them
 * drifted — at 0.1.6 the README said 0.1.3, the intro said 0.1.4, and the curl
 * pointed at a jar that returns 404. With five packages there is no version of
 * "remember to update them all" that survives a release.
 *
 * So the sources carry a token and the build substitutes it. There is one number,
 * it lives in `typescript/package.json` beside the code it describes, and a page
 * cannot disagree with it because a page never states it.
 *
 *   version %%TDC_VERSION%%          →  version 0.1.6
 *   <version>%%TDC_VERSION%%</version>
 *
 * A remark plugin rather than a React component, and that is the whole reason it
 * exists: half the mentions are inside fenced code blocks — XML, Gradle, a shell
 * command — where a component cannot go. remark sees the code block's text, so
 * one rule covers prose, inline code and fences alike.
 *
 * The markdown export does the same substitution on its way out
 * (`scripts/export-markdown.mjs`), so the copy GitHub renders carries the real
 * number too. Both read this file's `VERSION`; there is no second definition.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { visit } from 'unist-util-visit';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The one number. The packages declare it; nothing else may. */
export const VERSION = JSON.parse(
  readFileSync(join(HERE, '..', '..', 'typescript', 'package.json'), 'utf8'),
).version;

export const TOKEN = '%%TDC_VERSION%%';

/** The token for the one registry that can be behind. */
export const JAVA_TOKEN = '%%TDC_JAVA_VERSION%%';

/**
 * What is actually ON MAVEN CENTRAL, which is not always what this tree builds.
 *
 * Central caps how many releases it accepts from a project per month, and this
 * project reaches that cap. When it does, the jar stays where it was while the
 * other four registries move on — for one release or for several, until the
 * allowance resets and everything that piled up goes out at once. Meanwhile the
 * Maven coordinate on the install page is the one instruction on this site that
 * a reader cannot work around: a `<version>` that is not there does not resolve,
 * and the build fails in their project, not ours.
 *
 * So Java gets its own token, and its value is not written down anywhere new.
 * `java/CHANGELOG.md` already records the difference, because a changelog has to:
 *
 *   ## [0.2.2] — not published      built, signed, waiting for the allowance
 *   ## [0.2.1] — 2026-08-11         on Central, and what the page must say
 *
 * The newest heading carrying a DATE is the newest version a reader can install.
 * Publishing the backlog means changing "not published" to a date, and this
 * follows on the next build — one edit, in the file that had to be edited anyway.
 */
function javaOnCentral() {
  const changelog = readFileSync(join(HERE, '..', '..', 'java', 'CHANGELOG.md'), 'utf8');
  for (const m of changelog.matchAll(/^##\s*\[(\d+\.\d+\.\d+)\]\s*—\s*(.+)$/gm)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(m[2].trim())) return m[1];
  }
  // No dated release at all: a fresh checkout of a package that has never
  // shipped. Saying the built version is the honest answer there.
  return VERSION;
}

export const JAVA_VERSION = javaOnCentral();

/**
 * The catalogue's own arithmetic, read from the manifest the bundles are built
 * from.
 *
 * Same disease as the version, same cure. `installing-packs.mdx` said "108 sets
 * today: common, ten languages, and 97 countries" one release after the answer
 * became 109 and 98 — a sentence nobody thinks to revisit when a country pack
 * lands, because the pack does not live anywhere near the page. Now the page
 * states no number; it asks for one.
 *
 *   %%TDC_PACK_SETS%%       every downloadable bundle
 *   %%TDC_PACK_COUNTRIES%%  the ones that are a country
 *   %%TDC_PACK_LANGUAGES%%  the rest, minus `common`
 */
function packCounts() {
  const manifest = JSON.parse(
    readFileSync(join(HERE, '..', '..', 'data', 'bundles.json'), 'utf8'),
  );
  const bundles = manifest.bundles;
  const countries = bundles.filter((b) =>
    b.packs.some((p) => p.startsWith('packs/countries/')),
  ).length;
  return {
    '%%TDC_PACK_SETS%%': String(bundles.length),
    '%%TDC_PACK_COUNTRIES%%': String(countries),
    '%%TDC_PACK_LANGUAGES%%': String(bundles.length - countries - 1),
  };
}

/**
 * When the documentation last CHANGED — the date of the newest commit touching a
 * page, in any language.
 *
 * The commit date rather than the build clock, and that is the whole point. A
 * page stamped with `new Date()` answers "when was this rebuilt", which is not
 * the question a reader has; it also makes every rebuild differ from the last for
 * no reason, so a diff of the built site stops meaning anything. The commit date
 * answers "how old is what I am reading", and two builds of one commit agree.
 *
 * Falls back to today when git cannot answer — a source tarball, a shallow
 * checkout — because a date that is roughly right beats a page with a hole in it.
 *
 *   %%TDC_UPDATED%%   ->  2026-08-09
 */
function lastUpdated() {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cs', '--', 'webdoc/docs', 'webdoc/i18n'],
      { cwd: join(HERE, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch {
    // git absent, or not a checkout: fall through.
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * The month written out, in the language of the page it lands on.
 *
 * `2026-08-10` is only unambiguous to a reader who knows ISO. Everyone else
 * splits on nationality: an American reads `08/10` as 8 October, a Russian as
 * 10 August, and neither of them is wrong about their own convention. A month
 * spelled as a WORD cannot be misread, which is the whole point.
 *
 * The names are written out rather than taken from `Intl`, for two reasons that
 * both bit on the way here: `toLocaleDateString('ru-RU', …)` appends a bare
 * ` г.`, and `new Date('2026-08-10')` is UTC midnight, so west of Greenwich
 * `.getDate()` answers 9. The ISO string is split instead of parsed.
 */
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June',
       'July', 'August', 'September', 'October', 'November', 'December'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
       'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
       'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
};

export function spellDate(iso, locale = 'en') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, year, month, day] = m;
  const names = MONTHS[locale] ?? MONTHS.en;
  const name = names[Number(month) - 1];
  const d = String(Number(day)); // no leading zero: "8 August", not "08 August"
  if (locale === 'es') return `${d} de ${name} de ${year}`;
  return `${d} ${name} ${year}`;
}

/** Which translation a file belongs to, read from its path. */
function localeOf(file) {
  const path = String(file?.path ?? file?.history?.[0] ?? '');
  const m = /[/\\]i18n[/\\]([a-z]{2})[/\\]/.exec(path);
  return m ? m[1] : 'en';
}

/** The machine form, resolved once; every page spells it in its own language. */
export const ISO_UPDATED = lastUpdated();

/** Every token the build substitutes, resolved once. */
export const TOKENS = {
  [TOKEN]: VERSION,
  [JAVA_TOKEN]: JAVA_VERSION,
  '%%TDC_UPDATED%%': spellDate(ISO_UPDATED, 'en'),
  ...packCounts(),
};

/** Every node kind whose value a reader can end up copying. */
const CARRIES_TEXT = ['text', 'code', 'inlineCode', 'html', 'yaml'];

export default function remarkVersion() {
  return (tree, file) => {
    // Resolved per file: the same ISO date, spelled in the page's own language.
    const tokens = { ...TOKENS, '%%TDC_UPDATED%%': spellDate(ISO_UPDATED, localeOf(file)) };
    for (const type of CARRIES_TEXT) {
      visit(tree, type, (node) => {
        if (typeof node.value !== 'string') return;
        for (const [token, value] of Object.entries(tokens)) {
          if (node.value.includes(token)) node.value = node.value.split(token).join(value);
        }
      });
    }
    // A token inside a JSX attribute — `<Terminal title="tdcv2 %%TDC_VERSION%%">`
    // — is not a text node, so it is reached through the attribute values.
    //
    // Guarded by Array.isArray, not by `?? []`: an admonition (`:::note`) is a
    // containerDirective whose `attributes` is a plain object map, and spreading
    // that threw "object is not iterable" on every page carrying one.
    visit(tree, (node) => {
      if (!Array.isArray(node.attributes)) return;
      for (const attr of node.attributes) {
        if (typeof attr.value !== 'string') continue;
        for (const [token, value] of Object.entries(tokens)) {
          if (attr.value.includes(token)) attr.value = attr.value.split(token).join(value);
        }
      }
    });
  };
}
