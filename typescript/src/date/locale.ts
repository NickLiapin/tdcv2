/**
 * Date locale registry used by the portable TDC date formatter.
 *
 * The tables live in `locale-tables.ts`; this file resolves a name to one.
 */

import {
  EN,
  ES,
  ZH_CN,
  FR,
  AR,
  PT,
  DE,
  IT,
  TR,
  ID,
  VI,
  JA,
  KO,
  NL,
  SV,
  HI,
  TH,
  HU,
} from './locale-tables.js';
import { RU, PL, UK, EL, CS, FI } from './locale-tables-inflected.js';

import type { DateLocale } from './locale-tables.js';

export type { DateLocale } from './locale-tables.js';

const LOCALES = new Map<string, DateLocale>([
  ['en', EN],
  ['eng', EN],
  ['ru', RU],
  ['es', ES],
  ['spa', ES],
  ['zh-cn', ZH_CN],
  ['zh', ZH_CN],
  ['fr', FR],
  ['fra', FR],
  ['ar', AR],
  ['ara', AR],
  ['pt', PT],
  ['por', PT],
  ['de', DE],
  ['deu', DE],
  ['it', IT],
  ['ita', IT],
  ['pl', PL],
  ['pol', PL],
  ['el', EL],
  ['ell', EL],
  ['uk', UK],
  ['ukr', UK],
  ['tr', TR],
  ['tur', TR],
  ['id', ID],
  ['ind', ID],
  ['vi', VI],
  ['vie', VI],
  ['ja', JA],
  ['jpn', JA],
  ['ko', KO],
  ['kor', KO],
  ['nl', NL],
  ['nld', NL],
  ['cs', CS],
  ['ces', CS],
  ['th', TH],
  ['hi', HI],
  ['sv', SV],
  ['hu', HU],
  ['hun', HU],
  ['fi', FI],
  ['fin', FI],
]);

export const DATE_LOCALE_NAMES: readonly string[] = [
  'ar',
  'cs',
  'de',
  'el',
  'en',
  'es',
  'fi',
  'fr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'hi',
  'nl',
  'pl',
  'pt',
  'ru',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-cn',
];

/*
 * Date locales a DATA PACK shipped, keyed by locale name.
 *
 * Seventy locales carry a `DATE_LOCALE.json` beside their name lists, and for
 * years the engine never read one: `local="ka"` drew Georgian names and printed
 * English months, with the right words sitting in the pack the whole time. The
 * pack scan parses them and registers them here; the BUILT-IN tables above
 * always win, so the twenty-four locales the engine always knew keep their
 * bytes, and the registry only fills the gap.
 */
const PACK_LOCALES = new Map<string, DateLocale>();

export function registerPackDateLocales(entries: ReadonlyMap<string, DateLocale>): void {
  for (const [name, locale] of entries) PACK_LOCALES.set(name, locale);
}

export function resolveDateLocale(name: string | undefined): DateLocale {
  const key = name ?? 'en';
  return LOCALES.get(key) ?? PACK_LOCALES.get(key) ?? EN;
}

export function isKnownDateLocale(name: string): boolean {
  return LOCALES.has(name) || PACK_LOCALES.has(name);
}
