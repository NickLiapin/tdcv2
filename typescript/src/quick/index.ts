/**
 * The quick API: one value, one line, no config file.
 *
 *     import { tdc } from 'tdcv2';
 *
 *     tdc.person.male.firstName();          // John
 *     tdc.country.usa.docs.ssn();           // 690070001, check digits and all
 *     tdc.lang.ru.person.lastName();        // Иванов
 *     tdc.person.lastName.many(10);         // ten of them
 *     tdc.seed('demo').locale('ru').person.lastName();
 *     tdc.gen.number('20..30');             // "23"
 *
 * ONE RULE: a dot in the code is a dot in the address. `person.male.firstName`
 * here is `person.male.firstName` in a config and in the reference. Any
 * shorthand would be a second vocabulary to learn, keep in step with the docs,
 * and carry into four other languages.
 *
 * A leading segment may be left out, exactly as in a config: then the address
 * is read against the active locale. `tdc.person.lastName()` gives Williams in
 * `en` and Иванов in `ru`.
 *
 * To name a pack outright, say what kind it is: `tdc.lang.ru.…` for a language
 * and `tdc.country.usa.…` for a country. Those two words carry no meaning in an
 * address — they are there so the completion list at `tdc.` stays a list of
 * CATEGORIES. Putting 122 locale and country codes in with them turned it into
 * a wall of names nobody could read.
 *
 * WHAT THIS IS NOT. Every call is independent. Nothing here ties one value to
 * another — no `<switch>` on a drawn column, no `parent=`, no `uniq`, no
 * `<compute>`. A coherent record is a config; this is the drawer of loose
 * values that Faker occupies, answered with the same data packs.
 *
 * Values are always strings, including numbers and dates: the engine's world is
 * text, and a result type that changed with the address would break both
 * autocomplete and the ports.
 */

import { randomBytes } from 'node:crypto';

import type { QuickAddressTree } from './addresses.js';
import { type QuickGenSpec, QuickDraw, TdcQuickError } from './draw.js';
import type { QuickAddress, QuickGen, QuickGenCall, QuickParams } from './types.js';

export { TdcQuickError, BATCH_ROWS } from './draw.js';
export type { QuickAddress, QuickGen, QuickGenCall, QuickParams } from './types.js';
export type { QuickAddressTree } from './addresses.js';

/**
 * What `tdc` is: three named things, and every bundled address by name.
 *
 * `seed` and `locale` return a NEW object rather than changing this one, so
 * two tests can hold different seeds at the same time.
 */
export type QuickTdc = QuickAddressTree & {
  readonly seed: (value: string) => QuickTdc;
  readonly locale: (value: string) => QuickTdc;
  readonly gen: QuickGen;
};

/**
 * Words the API answers to at the ROOT, so no data CATEGORY may be called one
 * of them. `location.country` is fine — `country` there is a leaf, and only the
 * first name after `tdc.` is intercepted.
 */
export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  'gen',
  'seed',
  'locale',
  'lang',
  'country',
]);

/**
 * Words the API answers to at EVERY level of an address, so no segment
 * anywhere may be called one of them. There is exactly one, and a test holds
 * the bundled packs to it.
 */
export const RESERVED_PATH_NAMES: ReadonlySet<string> = new Set(['many']);

/**
 * Property names a proxy must not answer to, because the language and the
 * runtime ask for them behind the reader's back. `then` is the dangerous one:
 * answering it makes every value look like a promise to `await`.
 */
const NOT_A_SEGMENT: ReadonlySet<string> = new Set([
  'then',
  'catch',
  'finally',
  'constructor',
  'prototype',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'nodeType',
  '$$typeof',
]);

const asAttributes = (params: QuickParams | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]));

function addressProxy(draw: QuickDraw, segments: readonly string[]): QuickAddress {
  const spec = (params?: QuickParams): QuickGenSpec => ({
    type: 'template',
    attrs: { value: segments.join('.'), ...asAttributes(params) },
  });
  const target = (): void => undefined;
  return new Proxy(target as unknown as QuickAddress, {
    get(_target, property): unknown {
      if (typeof property !== 'string' || NOT_A_SEGMENT.has(property)) return undefined;
      if (property === 'many') {
        return (count: number, params?: QuickParams): string[] => draw.draw(spec(params), count);
      }
      return addressProxy(draw, [...segments, property]);
    },
    apply(_target, _thisArg, args: unknown[]): string {
      return draw.draw(spec(args[0] as QuickParams | undefined), 1)[0] ?? '';
    },
  });
}

/**
 * `tdc.gen.<type>(…)` — the engine's own generators, which have attributes
 * rather than addresses. They live under one name because pack categories are
 * already called `date`, `text` and `word`, so the top level is not free.
 *
 * A string argument is the `value` attribute, which is what nearly every call
 * wants: `tdc.gen.number('20..30')` is `tdc.gen.number({ value: '20..30' })`.
 */
function genProxy(draw: QuickDraw): QuickGen {
  return new Proxy({} as QuickGen, {
    get(_target, property): unknown {
      if (typeof property !== 'string' || NOT_A_SEGMENT.has(property)) return undefined;
      const spec = (arg?: string | QuickParams): QuickGenSpec => ({
        type: property,
        attrs: typeof arg === 'string' ? { value: arg } : asAttributes(arg),
      });
      const call = ((arg?: string | QuickParams): string =>
        draw.draw(spec(arg), 1)[0] ?? '') as QuickGenCall;
      call.many = (count: number, arg?: string | QuickParams): string[] =>
        draw.draw(spec(arg), count);
      return call;
    },
  });
}

/**
 * The thing behind `lang` and `country`: whatever name comes next starts the
 * address. `tdc.country.usa.docs.ssn()` is the address `usa.docs.ssn`.
 */
function packProxy(draw: QuickDraw): Record<string, QuickAddress> {
  return new Proxy(
    {},
    {
      get(_target, property): unknown {
        if (typeof property !== 'string' || NOT_A_SEGMENT.has(property)) return undefined;
        return addressProxy(draw, [property]);
      },
    },
  );
}

function makeQuick(seed: string, locale: string | undefined): QuickTdc {
  const draw = new QuickDraw(seed, locale);
  return new Proxy({} as QuickTdc, {
    get(_target, property): unknown {
      if (typeof property !== 'string' || NOT_A_SEGMENT.has(property)) return undefined;
      if (property === 'seed') {
        return (value: string): unknown => makeQuick(value, locale);
      }
      if (property === 'locale') {
        return (value: string): unknown => makeQuick(seed, value);
      }
      if (property === 'gen') return genProxy(draw);
      // `lang` and `country` are signposts, not address segments: they say what
      // the next name is, and then step out of the way.
      if (property === 'lang' || property === 'country') return packProxy(draw);
      return addressProxy(draw, [property]);
    },
  });
}

/**
 * A seed nobody chose.
 *
 * Without `tdc.seed(...)` the quick API is random per process, the way Faker
 * is — a test that wants the same values twice asks for them by name.
 */
const randomSeed = (): string => randomBytes(8).toString('hex');

/**
 * The default entry point: random per process, locale from the project config.
 *
 * `tdc.seed(...)` and `tdc.locale(...)` each return a NEW quick object and
 * change nothing globally, so two tests can hold different seeds at once.
 */
export const tdc: QuickTdc = makeQuick(randomSeed(), undefined);

export { TdcQuickError as QuickError };
