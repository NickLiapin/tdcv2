/**
 * The quick API — one value without a config.
 *
 * The cases that matter are the ones a naive implementation gets wrong: a loop
 * of calls must not repeat the same value, two objects with the same seed must
 * agree, and a typo must say what was meant instead of returning an empty
 * string.
 */

import { describe, expect, it } from 'vitest';

import {
  RESERVED_PATH_NAMES,
  RESERVED_ROOT_NAMES,
  TdcQuickError,
  tdc,
} from '../../src/quick/index.js';
import { QuickDraw } from '../../src/quick/draw.js';
import { CANONICAL_LOCALES, bundledPacksDir, scanPacks } from '../../src/data-pack/index.js';

describe('quick API', () => {
  it('draws a value from a pack address', () => {
    const value = tdc.seed('t1').locale('en').person.male.firstName();
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });

  it('does not repeat itself when called in a loop', () => {
    const t = tdc.seed('t2').locale('en');
    const drawn = Array.from({ length: 20 }, () => t.person.male.firstName());
    // The trap this whole layer exists to avoid: a config rendered one row at
    // a time returns the same row every time.
    expect(new Set(drawn).size).toBeGreaterThan(1);
  });

  it('is reproducible: same seed, same values', () => {
    const a = tdc.seed('same').locale('en').person.lastName.many(8);
    const b = tdc.seed('same').locale('en').person.lastName.many(8);
    expect(a).toEqual(b);
  });

  it('differs between seeds', () => {
    const a = tdc.seed('one').locale('en').person.lastName.many(8).join();
    const b = tdc.seed('two').locale('en').person.lastName.many(8).join();
    expect(a).not.toBe(b);
  });

  it('keeps one stream per address, whatever the call order', () => {
    const straight = tdc.seed('mix').locale('en');
    const first = [straight.person.lastName(), straight.person.lastName()];

    const interleaved = tdc.seed('mix').locale('en');
    const second = [
      interleaved.person.lastName(),
      (() => {
        interleaved.person.male.firstName();
        return interleaved.person.lastName();
      })(),
    ];
    expect(second).toEqual(first);
  });

  it('honours the locale', () => {
    const ru = tdc.seed('loc').locale('ru').person.lastName();
    const en = tdc.seed('loc').locale('en').person.lastName();
    expect(ru).not.toBe(en);
    expect(ru).toMatch(/\p{Script=Cyrillic}/u);
  });

  it('names a pack outright through lang and country', () => {
    // `lang` and `country` are signposts, not segments: the address behind
    // `tdc.lang.ru.person.lastName` is `ru.person.lastName`.
    const viaLocale = tdc.seed('abs').locale('ru').person.lastName();
    const spelledOut = tdc.seed('abs').locale('en').lang.ru.person.lastName();
    expect(spelledOut).toBe(viaLocale);

    const ssn = tdc.seed('abs').locale('ru').country.usa.docs.ssn();
    expect(ssn).toMatch(/^\d{9}$/);
  });

  it('runs the engine generators under gen', () => {
    const t = tdc.seed('gen').locale('en');
    const n = Number(t.gen.number('20..30'));
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(30);
    expect(t.gen.regex('[A-Z]{3}')).toMatch(/^[A-Z]{3}$/);
    expect(t.gen.number.many(4, '1..9')).toHaveLength(4);
  });

  it('passes parameters through to the pack', () => {
    const email = tdc.seed('p').locale('en').common.internet.email({ domain: 'example.test' });
    expect(email.endsWith('@example.test')).toBe(true);
  });

  it('names the nearest address when one is misspelled', () => {
    // The generated types already refuse a misspelled address at compile time —
    // which is the point of generating them — so a test about the RUNTIME
    // message has to reach the draw directly.
    const draw = new QuickDraw('e', 'en');
    expect(() => draw.draw({ type: 'template', attrs: { value: 'person.lastNam' } }, 1)).toThrow(
      TdcQuickError,
    );
    try {
      draw.draw({ type: 'template', attrs: { value: 'usa.docs.sn' } }, 1);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('usa.docs.ssn');
    }
  });

  it('refuses a count that is not a positive whole number', () => {
    expect(() => tdc.seed('c').locale('en').person.lastName.many(0)).toThrow(TdcQuickError);
    expect(() => tdc.seed('c').locale('en').person.lastName.many(1.5)).toThrow(TdcQuickError);
  });

  it('refuses to call a branch that is not an address', () => {
    // `common.device` only holds `common.device.imei` and `.iccid`. Calling it
    // used to compile and then throw, which is the opposite of the point of
    // generating types at all. The assertion is at COMPILE time: the branch has
    // no call signature, so this constant would not be `false` if it did.
    const callable: typeof tdc.common.device extends (...args: never[]) => unknown ? true : false =
      false;
    expect(callable).toBe(false);

    // And the leaf below it still works.
    expect(tdc.seed('b').locale('en').common.device.imei()).toMatch(/^\d/);
  });

  it('does not pretend to be a promise', () => {
    // Answering `then` would make every address await-able and silently wrong.
    const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
    expect(asRecord(tdc.person.lastName)['then']).toBeUndefined();
    expect(asRecord(tdc.gen)['then']).toBeUndefined();
  });

  it('keeps its reserved words out of the bundled addresses', () => {
    const dir = bundledPacksDir();
    const registry = scanPacks(dir === undefined ? [] : [dir]).registry;
    const addresses = [...registry.keys()];

    // `many` is answered at every level, so no segment anywhere may be it.
    const anywhere = addresses.filter((address) =>
      address.split('.').some((segment) => RESERVED_PATH_NAMES.has(segment)),
    );
    expect(anywhere).toEqual([]);

    // The rest are answered only after `tdc.`, so the rule is about CATEGORIES
    // — the name right after a locale code, which is what the root offers.
    // `location.country` is not a clash: there `country` is a leaf.
    const categories = new Set(
      addresses
        .filter((address) => CANONICAL_LOCALES.has(address.split('.')[0] ?? ''))
        .map((address) => address.split('.')[1] ?? ''),
    );
    const atRoot = [...categories].filter((name) => RESERVED_ROOT_NAMES.has(name));
    expect(atRoot).toEqual([]);
  });
});
