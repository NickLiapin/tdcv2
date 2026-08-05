/**
 * Canonical locale set for data packs (locale-first addressing).
 *
 * Mirrors moment.js's `locale/*.js` files (135 locales) so the pack scheme
 * stays in lockstep with the date layer, plus `en` — moment ships no `en.js`
 * (English is its built-in default), but a data-pack system needs English.
 * Total: 136. A pack address's first segment must be one of these codes or a
 * reserved bucket (`common`).
 */

export type Direction = 'ltr' | 'rtl';

export const CANONICAL_LOCALES: ReadonlySet<string> = new Set([
  'af',
  'ar',
  'ar-dz',
  'ar-kw',
  'ar-ly',
  'ar-ma',
  'ar-sa',
  'ar-tn',
  'az',
  'be',
  'bg',
  'bm',
  'bn',
  'bn-bd',
  'bo',
  'br',
  'bs',
  'ca',
  'cs',
  'cv',
  'cy',
  'da',
  'de',
  'de-at',
  'de-ch',
  'dv',
  'el',
  'en',
  'en-au',
  'en-ca',
  'en-gb',
  'en-ie',
  'en-il',
  'en-in',
  'en-nz',
  'en-sg',
  'eo',
  'es',
  'es-do',
  'es-mx',
  'es-us',
  'et',
  'eu',
  'fa',
  'fi',
  'fil',
  'fo',
  'fr',
  'fr-ca',
  'fr-ch',
  'fy',
  'ga',
  'gd',
  'gl',
  'gom-deva',
  'gom-latn',
  'gu',
  'he',
  'hi',
  'hr',
  'hu',
  'hy-am',
  'id',
  'is',
  'it',
  'it-ch',
  'ja',
  'jv',
  'ka',
  'kk',
  'km',
  'kn',
  'ko',
  'ku',
  'ky',
  'lb',
  'lo',
  'lt',
  'lv',
  'me',
  'mi',
  'mk',
  'ml',
  'mn',
  'mr',
  'ms',
  'ms-my',
  'mt',
  'my',
  'nb',
  'ne',
  'nl',
  'nl-be',
  'nn',
  'oc-lnc',
  'pa-in',
  'pl',
  'pt',
  'pt-br',
  'ro',
  'ru',
  'sd',
  'se',
  'si',
  'sk',
  'sl',
  'sq',
  'sr',
  'sr-cyrl',
  'ss',
  'sv',
  'sw',
  'ta',
  'te',
  'tet',
  'tg',
  'th',
  'tk',
  'tl-ph',
  'tlh',
  'tr',
  'tzl',
  'tzm',
  'tzm-latn',
  'ug-cn',
  'uk',
  'ur',
  'uz',
  'uz-latn',
  'vi',
  'x-pseudo',
  'yo',
  'zh-cn',
  'zh-hk',
  'zh-mo',
  'zh-tw',
]);

export const RTL_LOCALES: ReadonlySet<string> = new Set([
  'ar',
  'ar-dz',
  'ar-kw',
  'ar-ly',
  'ar-ma',
  'ar-sa',
  'ar-tn',
  'dv',
  'fa',
  'he',
  'ku',
  'sd',
  'ug-cn',
  'ur',
]);

/**
 * Country names (full lowercase words, so they never collide with 2-letter
 * language codes). Gate valid country first-segments and catch typos. Country
 * generators (government IDs, plates, licenses) are addressed absolutely by
 * country: `usa.tax.ssn`, `russia.vehicle.plate`. Populated on demand — only
 * `usa` + `russia` carry data today.
 */
export const CANONICAL_COUNTRIES: ReadonlySet<string> = new Set([
  'argentina',
  'australia',
  'austria',
  'belgium',
  'bolivia',
  'brazil',
  'bulgaria',
  'canada',
  'chile',
  'china',
  'colombia',
  'costa_rica',
  'croatia',
  'cuba',
  'cyprus',
  'czechia',
  'denmark',
  'dominican_republic',
  'ecuador',
  'el_salvador',
  'equatorial_guinea',
  'estonia',
  'europe',
  'finland',
  'france',
  'germany',
  'greece',
  'guatemala',
  'honduras',
  'hungary',
  'ireland',
  'italy',
  'latvia',
  'lithuania',
  'luxembourg',
  'malta',
  'mexico',
  'netherlands',
  'new_zealand',
  'nicaragua',
  'panama',
  'paraguay',
  'peru',
  'poland',
  'portugal',
  'puerto_rico',
  'romania',
  'russia',
  'slovakia',
  'south_africa',
  'slovenia',
  'spain',
  'sweden',
  'united_kingdom',
  'uruguay',
  'usa',
  'venezuela',
  // Arabic-speaking country packs
  'egypt',
  'saudi_arabia',
  'uae',
  'qatar',
  'kuwait',
  'bahrain',
  'oman',
  'jordan',
  'lebanon',
  'syria',
  'iraq',
  'palestine',
  'morocco',
  'algeria',
  'tunisia',
  'libya',
  'sudan',
  'mauritania',
  'yemen',
  'comoros',
  'somalia',
  // French-speaking country packs
  'switzerland',
  'monaco',
  'senegal',
  'ivory_coast',
  'mali',
  'burkina_faso',
  'benin',
  'togo',
  'niger',
  'guinea',
  'cameroon',
  'gabon',
  'congo',
  'dr_congo',
  'chad',
  'madagascar',
  'rwanda',
  'djibouti',
  'haiti',
  // Russian-speaking country packs (Russian official / used on documents)
  'belarus',
  'kazakhstan',
  'kyrgyzstan',
  'tajikistan',
  // Portuguese-speaking country packs
  'portugal',
  'angola',
  'mozambique',
  'cape_verde',
  'guinea_bissau',
  'sao_tome_and_principe',
  'east_timor',
  'macau',
  // German-speaking country packs (Germany, Austria and Switzerland already listed)
  'liechtenstein',
  // Italian-speaking country packs (Italy already listed)
  'san_marino',
  'vatican_city',
]);

/**
 * Valid address roots that are neither languages nor countries. `common` =
 * language-agnostic shared data; `user` = the user's private, update-safe area
 * (physically their own directory, scanned via dataPaths).
 */
export const RESERVED_BUCKETS: ReadonlySet<string> = new Set(['common', 'user']);

export function directionOf(code: string): Direction {
  return RTL_LOCALES.has(code) ? 'rtl' : 'ltr';
}

/**
 * Resolve a template address to a concrete pack address (soft/hard rule):
 * if the first segment is a known locale, the address is absolute (hard) and
 * returned unchanged; otherwise it is relative (soft) and `locale` is
 * prepended. `person.male.firstName` + `ru` -> `ru.person.male.firstName`;
 * `fr.person.male.firstName` stays `fr.person.male.firstName`.
 */
export function resolvePackAddress(path: string, locale: string): string {
  const first = path.split('.')[0] ?? '';
  const isHard =
    CANONICAL_LOCALES.has(first) || CANONICAL_COUNTRIES.has(first) || RESERVED_BUCKETS.has(first);
  return isHard ? path : `${locale}.${path}`;
}

export interface LocaleManifest {
  readonly code: string;
  readonly direction: Direction;
}

export const MANIFEST_FILENAME = '_locale.json';

/**
 * Parse a `_locale.json` manifest. Tolerant: malformed JSON or missing fields
 * fall back to the folder's code and its canonical direction.
 */
export function parseLocaleManifest(content: string, fallbackCode: string): LocaleManifest {
  try {
    const raw = JSON.parse(content) as { code?: unknown; direction?: unknown };
    const code = typeof raw.code === 'string' && raw.code.length > 0 ? raw.code : fallbackCode;
    const direction: Direction =
      raw.direction === 'rtl' ? 'rtl' : raw.direction === 'ltr' ? 'ltr' : directionOf(code);
    return { code, direction };
  } catch {
    return { code: fallbackCode, direction: directionOf(fallbackCode) };
  }
}
