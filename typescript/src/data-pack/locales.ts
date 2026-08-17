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
  'albania',
  'armenia',
  'bosnia_and_herzegovina',
  'georgia',
  'iceland',
  'north_macedonia',
  'norway',
  'algeria',
  'angola',
  'argentina',
  'australia',
  'austria',
  'bahrain',
  'bangladesh',
  'belarus',
  'belgium',
  'benin',
  'bhutan',
  'bolivia',
  'brazil',
  'bulgaria',
  'burkina_faso',
  'cameroon',
  'cambodia',
  'canada',
  'cape_verde',
  'chad',
  'chile',
  'china',
  'colombia',
  'comoros',
  'congo',
  'costa_rica',
  'croatia',
  'cuba',
  'cyprus',
  'czechia',
  'denmark',
  'djibouti',
  'dominican_republic',
  'dr_congo',
  'east_timor',
  'ecuador',
  'egypt',
  'el_salvador',
  'equatorial_guinea',
  'estonia',
  'europe',
  'finland',
  'france',
  'gabon',
  'germany',
  'ghana',
  'greece',
  'guatemala',
  'guinea',
  'guinea_bissau',
  'haiti',
  'honduras',
  'hungary',
  'india',
  'indonesia',
  'iran',
  'iraq',
  'ireland',
  'israel',
  'italy',
  'ivory_coast',
  'japan',
  'jordan',
  'kazakhstan',
  'kenya',
  'kuwait',
  'kyrgyzstan',
  'laos',
  'latvia',
  'lebanon',
  'libya',
  'liechtenstein',
  'lithuania',
  'luxembourg',
  'macau',
  'madagascar',
  'malaysia',
  'mali',
  'malta',
  'mauritania',
  'mexico',
  'mongolia',
  'myanmar',
  'moldova',
  'monaco',
  'morocco',
  'mozambique',
  'nepal',
  'netherlands',
  'new_zealand',
  'nicaragua',
  'niger',
  'nigeria',
  'oman',
  'pakistan',
  'palestine',
  'panama',
  'paraguay',
  'peru',
  'philippines',
  'poland',
  'portugal',
  'puerto_rico',
  'qatar',
  'romania',
  'russia',
  'rwanda',
  'san_marino',
  'sao_tome_and_principe',
  'saudi_arabia',
  'senegal',
  'serbia',
  'singapore',
  'slovakia',
  'slovenia',
  'somalia',
  'south_africa',
  'south_korea',
  'spain',
  'sri_lanka',
  'sudan',
  'sweden',
  'switzerland',
  'syria',
  'taiwan',
  'tajikistan',
  'tanzania',
  'thailand',
  'togo',
  'tunisia',
  'turkey',
  'turkmenistan',
  'uae',
  'uganda',
  'ukraine',
  'united_kingdom',
  'uruguay',
  'usa',
  'vatican_city',
  'venezuela',
  'vietnam',
  'yemen',
  'zimbabwe',
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
