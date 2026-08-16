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

export function resolveDateLocale(name: string | undefined): DateLocale {
  return LOCALES.get(name ?? 'en') ?? EN;
}

export function isKnownDateLocale(name: string): boolean {
  return LOCALES.has(name);
}
