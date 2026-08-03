/**
 * The machinery under the quick API: turn one generator into an endless
 * stream of values.
 *
 * A quick call has to look like `faker.person.firstName()` and cost about what
 * that costs. Two measured facts shape everything here.
 *
 * FIRST, values depend on the row count, not only on the seed. The same
 * config run with `count="3"` yields `John | Robert | James`, and run three
 * times with `count="1"` yields `James | James | James`. So a call cannot mean
 * "render one row" — it has to mean "take the next value from a stream", or a
 * loop of calls returns the same value forever.
 *
 * SECOND, `toIterator()` is lazy: the first three values of a config declaring
 * a million rows arrive in 0 ms. So a stream is cheap to open and cheap to
 * abandon.
 *
 * A stream is therefore a run of `BATCH_ROWS` rows; when it is exhausted the
 * next run starts under a seed derived from the batch number, so the sequence
 * continues without bound and stays reproducible from the same starting seed.
 */

import { loadConfig } from '../config/config.js';
import { scanPacks, bundledPacksDir } from '../data-pack/index.js';
import { TDC, type TdcObjectRow } from '../lib/index.js';

/**
 * Rows per underlying run. Small enough that opening a stream is free, large
 * enough that a test drawing a few hundred values never reopens one.
 *
 * This number is part of the contract: change it and every seeded value
 * changes, because the draw depends on the declared count.
 */
export const BATCH_ROWS = 512;

/** One `<gen>`: its type and the attributes written on it. */
export interface QuickGenSpec {
  readonly type: string;
  readonly attrs: Readonly<Record<string, string>>;
}

/** Raised for anything the quick API can explain better than the engine can. */
export class TdcQuickError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TdcQuickError';
  }
}

interface Cursor {
  batch: number;
  rows: Iterator<TdcObjectRow>;
}

function escapeAttribute(value: string): string {
  if (value.includes('"')) {
    throw new TdcQuickError(`a double quote is not allowed in a generator value: ${value}`);
  }
  return value;
}

function configFor(spec: QuickGenSpec, locale: string | undefined, seed: string): string {
  const attrs = Object.entries(spec.attrs)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  const local = locale === undefined ? '' : ` local="${escapeAttribute(locale)}"`;
  return (
    `<tdc><env count="${String(BATCH_ROWS)}" seed="${escapeAttribute(seed)}"${local}>` +
    `<sequence name="V"><gen type="${spec.type}"${attrs}/></sequence></env>` +
    '<block><line><data>${{V}}</data></line></block></tdc>'
  );
}

const keyOf = (spec: QuickGenSpec): string =>
  `${spec.type}|${Object.entries(spec.attrs)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')}`;

/** Edit distance, capped: only used to say "did you mean". */
function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let carry = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j] ?? 0;
      prev[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + 1,
        carry + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      carry = keep;
    }
  }
  return prev[b.length] ?? 0;
}

/**
 * Every address reachable right now — the bundled packs plus whatever the
 * project's `tdcv2.config.json` registered.
 *
 * ONE list, because both halves of the message read it. Scanning bundled packs
 * for "did you mean" and bundled-plus-project for "that pack is not installed"
 * let a single sentence contradict itself: the half that proposes a near miss
 * cannot see the pack the other half has just confirmed is there.
 *
 * A config this cannot read leaves the list empty rather than throwing. This
 * runs while a diagnostic is being formatted, and a second failure raised from
 * inside the handler for the first one loses the message the caller needed.
 */
function knownAddresses(): readonly string[] {
  try {
    const roots = [bundledPacksDir(), ...loadConfig({ cwd: process.cwd() }).dataPaths].filter(
      (p): p is string => p !== undefined,
    );
    return [...scanPacks(roots).registry.keys()];
  } catch {
    return [];
  }
}

/**
 * The nearest reachable address to what was typed.
 *
 * Compared against the address as written AND against its locale-qualified
 * form, because `person.firstNam` and `en.person.firstNam` are the same typo
 * seen from two sides.
 */
export function nearestAddress(
  typed: string,
  locale: string,
  known: readonly string[],
): string | undefined {
  const qualified = `${locale}.${typed}`;
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const address of known) {
    const score = Math.min(distance(typed, address), distance(qualified, address));
    if (score < bestScore) {
      bestScore = score;
      best = address;
    }
  }
  // Three edits away is a different address, not a typo.
  return bestScore <= 3 ? best : undefined;
}

/**
 * The pack an address names, when that pack is real but not on this machine.
 *
 * npm carries a starter set — `common`, `en`, `usa` — and the registry carries
 * the other hundred-odd. So `tdc.lang.ru.person.lastName()` on a fresh install
 * fails not because `ru` is a typo but because `ru` has not been downloaded
 * yet, and answering it with "did you mean en.person.lastName?" answers a
 * question the caller did not ask: they wanted Russian.
 *
 * The test is STRUCTURAL rather than a table of locale and country codes, so it
 * holds for packs that do not exist yet: nothing at all sits under the first
 * segment, but the REST of the address resolves somewhere — a name standing
 * where a pack goes. A table answers `zz.person.lastName` with "did you mean
 * ar.person.lastName?", which is the very swap this message was written to
 * avoid; the structural test answers it with the pack.
 *
 * A typo in the tail fails one of the two halves — `ru.person.lastNam` leaves
 * `ru` reachable, `persn.lastName` resolves nowhere — and falls through to the
 * "did you mean" path.
 */
function uninstalledPack(address: string, known: readonly string[]): string | undefined {
  const dot = address.indexOf('.');
  if (dot <= 0 || dot === address.length - 1) return undefined;
  const head = address.slice(0, dot);
  const tail = address.slice(dot + 1);
  const prefix = `${head}.`;
  if (known.some((a) => a.startsWith(prefix))) return undefined;
  const suffix = `.${tail}`;
  return known.some((a) => a === tail || a.endsWith(suffix)) ? head : undefined;
}

/**
 * Streams held open per generator, for one seed and one locale.
 *
 * Keyed by the generator and its attributes: two different addresses draw
 * independently, and the same address asked twice continues where it left off.
 */
export class QuickDraw {
  private readonly cursors = new Map<string, Cursor>();

  public constructor(
    private readonly seed: string,
    private readonly locale: string | undefined,
  ) {}

  public draw(spec: QuickGenSpec, count: number): string[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new TdcQuickError(`count must be a positive whole number, got ${String(count)}`);
    }
    const key = keyOf(spec);
    let cursor = this.cursors.get(key);
    if (!cursor) {
      cursor = { batch: 0, rows: this.open(spec, 0) };
      this.cursors.set(key, cursor);
    }
    const out: string[] = [];
    while (out.length < count) {
      const step = cursor.rows.next();
      if (step.done === true) {
        cursor.batch += 1;
        cursor.rows = this.open(spec, cursor.batch);
        continue;
      }
      // One sequence, one column: the row is `{ V: <the value> }`, and the
      // value of a scalar sequence is a string. A compound row cannot appear
      // here — this layer never builds one.
      const value = step.value['V'];
      out.push(typeof value === 'string' ? value : '');
    }
    return out;
  }

  private open(spec: QuickGenSpec, batch: number): Iterator<TdcObjectRow> {
    const seed = batch === 0 ? this.seed : `${this.seed}#${String(batch)}`;
    let tdc: TDC;
    try {
      tdc = new TDC({ configString: configFor(spec, this.locale, seed) });
    } catch (error) {
      throw this.explain(spec, error);
    }
    return tdc.iterate();
  }

  /**
   * Turn an engine diagnostic about a config the caller never wrote into a
   * sentence about the call they did write — but ONLY when the address really
   * is what went wrong.
   *
   * Rewriting every failure hides the one line that says what is actually
   * wrong: an attribute the validator refused came back as `unknown address
   * "common.internet.email". Did you mean "common.internet.email"?`, which is
   * nonsense. An address the packs do resolve cannot be the explanation, so
   * whatever the engine said is raised as it came.
   */
  private explain(spec: QuickGenSpec, error: unknown): Error {
    const raised = error instanceof Error ? error : new Error(String(error));
    if (spec.type !== 'template') return raised;
    const address = spec.attrs['value'] ?? '';
    const locale = this.locale ?? 'en';
    const known = knownAddresses();
    const missing = uninstalledPack(address, known);
    if (missing !== undefined) {
      return new TdcQuickError(
        `the "${missing}" pack is not installed, so "${address}" cannot be drawn. ` +
          `Install it with \`tdcv2 pack add ${missing}\` ` +
          '(run `tdcv2 init` once first, to say where packs go).',
      );
    }
    if (known.includes(address) || known.includes(`${locale}.${address}`)) return raised;
    const near = nearestAddress(address, locale, known);
    return new TdcQuickError(
      `unknown address "${address}" (locale "${locale}")` +
        (near === undefined ? '' : `. Did you mean "${near}"?`),
    );
  }
}
