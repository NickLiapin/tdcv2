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
  'afghanistan',
  'albania',
  'algeria',
  'angola',
  'argentina',
  'armenia',
  'australia',
  'austria',
  'azerbaijan',
  'bahrain',
  'bangladesh',
  'belarus',
  'belgium',
  'benin',
  'bhutan',
  'bolivia',
  'bosnia_and_herzegovina',
  'botswana',
  'brazil',
  'bulgaria',
  'burkina_faso',
  'burundi',
  'cambodia',
  'cameroon',
  'canada',
  'cape_verde',
  'central_african_republic',
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
  'eritrea',
  'estonia',
  'eswatini',
  'ethiopia',
  'europe',
  'finland',
  'france',
  'gabon',
  'gambia',
  'georgia',
  'germany',
  'ghana',
  'greece',
  'guatemala',
  'guinea',
  'guinea_bissau',
  'haiti',
  'honduras',
  'hungary',
  'iceland',
  'india',
  'indonesia',
  'iran',
  'iraq',
  'ireland',
  'israel',
  'italy',
  'ivory_coast',
  'jamaica',
  'japan',
  'jordan',
  'kazakhstan',
  'kenya',
  'kuwait',
  'kyrgyzstan',
  'laos',
  'latvia',
  'lebanon',
  'lesotho',
  'liberia',
  'libya',
  'liechtenstein',
  'lithuania',
  'luxembourg',
  'macau',
  'madagascar',
  'malawi',
  'malaysia',
  'maldives',
  'mali',
  'malta',
  'mauritania',
  'mauritius',
  'mexico',
  'moldova',
  'monaco',
  'mongolia',
  'montenegro',
  'morocco',
  'mozambique',
  'myanmar',
  'namibia',
  'nepal',
  'netherlands',
  'new_zealand',
  'nicaragua',
  'niger',
  'nigeria',
  'north_korea',
  'north_macedonia',
  'norway',
  'oman',
  'pakistan',
  'palestine',
  'panama',
  'papua_new_guinea',
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
  'sierra_leone',
  'singapore',
  'slovakia',
  'slovenia',
  'somalia',
  'south_africa',
  'south_korea',
  'south_sudan',
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
  'trinidad_and_tobago',
  'tunisia',
  'turkey',
  'turkmenistan',
  'uae',
  'uganda',
  'ukraine',
  'united_kingdom',
  'uruguay',
  'usa',
  'uzbekistan',
  'vatican_city',
  'venezuela',
  'vietnam',
  'yemen',
  'zambia',
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
/**
 * Namespaces the loaded packs turned out to have.
 *
 * The scanner fills this in as it registers files. It exists because the
 * alternative — asking a list compiled into the library whether a name is a
 * country — made the DATA depend on the library's version: a pack written after
 * a release was refused by every installed copy, and `japan.geo.prefecture` was
 * not even recognised as an absolute address, so the locale was glued in front
 * of it.
 *
 * Recording what the scan found, rather than threading a registry through every
 * call site, keeps this to one line in the scanner — which matters, because the
 * same rule has to hold in five implementations.
 */
const discoveredNamespaces = new Set<string>();

/** Called by the pack scanner for every address it registers. */
export function noteNamespace(head: string): void {
  if (head.length > 0) discoveredNamespaces.add(head);
}

const headCache = new WeakMap<object, ReadonlySet<string>>();

/**
 * Every first segment the loaded packs actually provide.
 *
 * Computed once per registry and cached against it, because the answer only
 * changes when the packs do.
 */
function headsOf(registry: ReadonlyMap<string, unknown>): ReadonlySet<string> {
  const cached = headCache.get(registry);
  if (cached !== undefined) return cached;
  const heads = new Set<string>();
  for (const address of registry.keys()) heads.add(address.split('.')[0] ?? '');
  headCache.set(registry, heads);
  return heads;
}

/**
 * The base language of a regional variant — `en-gb` → `en`, `en` → undefined.
 *
 * One step, deliberately. A variant defers to the language it is a variant OF
 * and to nothing else: `zh-tw` reaches `zh` (which ships nothing) and stops,
 * rather than walking on to `zh-cn` and handing Traditional readers Simplified
 * data. Falling all the way back to English would be worse still — silently
 * correct-looking output in the wrong language is the failure this project
 * exists to prevent.
 */
export function baseLocale(locale: string): string | undefined {
  const dash = locale.indexOf('-');
  return dash > 0 ? locale.slice(0, dash) : undefined;
}

export function resolvePackAddress(
  path: string,
  locale: string,
  registry?: ReadonlyMap<string, unknown>,
): string {
  const first = path.split('.')[0] ?? '';
  /*
   * `CANONICAL_COUNTRIES` is a hint, not the authority. It is a list inside the
   * library, so relying on it made a config's meaning depend on the library's
   * VERSION: on 0.2.2, `japan.geo.prefecture` was not recognised as absolute and
   * got the locale glued in front of it, producing an address nobody wrote.
   *
   * The authority is what the loaded packs actually provide. When a registry is
   * to hand — which is every call site that then looks the address up — the
   * question "is this segment a namespace" is answered by the data. The list
   * stays as the answer for callers with no registry, and as the seed for
   * `tdcv2 pack` before anything is installed.
   */
  const isHard =
    CANONICAL_LOCALES.has(first) ||
    RESERVED_BUCKETS.has(first) ||
    discoveredNamespaces.has(first) ||
    (registry !== undefined && headsOf(registry).has(first)) ||
    CANONICAL_COUNTRIES.has(first);
  if (isHard) return path;
  const own = `${locale}.${path}`;
  // A variant answers for itself where it ships something, and defers to its
  // base language everywhere else — the rule RFC 4647 lookup and moment's own
  // `en-gb` → `en` follow. Only decidable with a registry to ask; callers
  // without one (there are a few) keep the plain locale-first address.
  if (registry === undefined || registry.has(own)) return own;
  const base = baseLocale(locale);
  if (base === undefined) return own;
  const inherited = `${base}.${path}`;
  return registry.has(inherited) ? inherited : own;
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
