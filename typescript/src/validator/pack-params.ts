/**
 * `<gen type="template" foo="bar">` — is `foo` a parameter this pack accepts?
 *
 * A generator pack's parameters are the names of the `<sequence>`s in its body:
 * passing `tax_office="7712"` replaces the sequence called `tax_office` for
 * that run. Anything else was accepted in silence and did nothing.
 *
 * That silence is how a whole class of rot went unnoticed. `country="GB"` on
 * `common.phone.e164` returns the same Brazilian number as `country="US"`, as
 * `country="RU"`, and as no attribute at all — the pack is one regex
 * alternation with no `country` sequence in it. The same is true of `length=`
 * on `common.id.nanoid`, `algorithm=` on `security.jwt`, `format=` on
 * `brazil.tax.cpf` and a dozen more: paths that became static packs, with the
 * parameters that used to shape them left behind in the documentation.
 *
 * A user who writes one of those reads the docs, gets no error, and receives
 * data they believe they configured. Saying so out loud is the whole fix.
 */

import {
  type Diagnostic,
  attrValueRange,
  closestMatch,
  formatCandidates,
} from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';

/**
 * Attributes that apply to a `<gen type="template">` whatever pack it names —
 * wrappers the ENGINE handles before the pack ever runs (naming, repetition,
 * missing/anomaly injection, formatting of the produced string).
 *
 * Everything outside this set has to be a parameter the pack declares. That is
 * what makes `format="formatted"` on `brazil.tax.cpf` reportable: `format` is a
 * real attribute of DATE templates, and those packs declare it, but the CPF
 * pack has no such sequence and silently ignored it.
 *
 * Kept deliberately generous — a name missing here becomes a hard error, and a
 * false error on a working config is worse than the silent no-op being fixed.
 */
const GEN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'anomaly',
  'anomaly_factor',
  'anomaly_flag',
  'case',
  'count',
  'flag',
  'if',
  'local',
  'mask',
  'missing',
  'missing_as',
  'name',
  'order',
  'parent',
  'repeat',
  'separator',
  'type',
  'value',
]);

export type PackParams = ReadonlyMap<string, ReadonlySet<string>>;

/** Address → parameter → the width the pack's own sequence always produces. */
export type PackParamWidths = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** The two lookups these checks read, plus the locale that resolves the address. */
export interface PackParamCtx {
  readonly locale: string;
  readonly packParams: PackParams | undefined;
  readonly packParamWidths: PackParamWidths | undefined;
}

/**
 * Report attributes on a template `<gen>` that the target pack cannot act on.
 *
 * Silent when the pack is unknown to this run (a locale-resolved shape, or no
 * registry supplied): guessing there would produce exactly the false errors
 * this check must not create.
 */
export function checkTemplateParams(
  attrs: readonly AttrContext[],
  attrMap: Readonly<Record<string, string>>,
  path: string,
  ctx: PackParamCtx,
  diagnostics: Diagnostic[],
): void {
  const { locale, packParams } = ctx;
  // A bare address is read against the active locale, exactly as the engine reads
  // it: `person.lastName` under `en` is the pack `en.person.lastName`. Looking up
  // only the literal text left every locale-relative address unchecked, so the
  // same mistake was caught on `common.internet.email` and waved through on
  // `person.lastName`.
  const declared = packParams?.get(path) ?? packParams?.get(`${locale}.${path}`);
  if (!declared) return;

  const widths = ctx.packParamWidths?.get(path) ?? ctx.packParamWidths?.get(`${locale}.${path}`);

  for (const attr of attrs) {
    const name = attr._attrName?.text;
    if (!name || GEN_ATTRIBUTES.has(name)) continue;

    // A parameter the pack DOES accept, pinned to a value of the wrong width.
    //
    // The packs that carry a check digit compute it over a fixed layout, so a
    // wrong-width value does not shift the layout — it breaks it. Measured on
    // `usa.finance.aba_routing`, whose own `prefix` is 2 characters:
    // `prefix="12345"` aborted the run with `<at>: index 8 is out of range`,
    // naming no file, line or code, and `tail="678"` said nothing at all and
    // wrote a six-digit number that is not a routing number. `check` passed on
    // both.
    //
    // Only reported where the width is a FACT read off the pack's own body —
    // an alternation whose items are all the same length, a regex with an exact
    // count, a zero-padded range. Anything else has no proven width and is
    // silent, because a refusal has to be a proof.
    if (declared.has(name)) {
      const want = widths?.get(name);
      const got = attrMap[name];
      const width = got === undefined ? undefined : Array.from(got).length;
      if (want !== undefined && width !== undefined && width !== want) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...attrValueRange(attr),
          message:
            `"${name}" is pinned to ${String(width)} characters, and "${path}" ` +
            `builds its value around a ${name}= of exactly ${String(want)}`,
          hint:
            `A pinned parameter replaces the pack's own value, and this pack has a fixed ` +
            `layout — a check digit is computed over the whole of it. Use a ${name}= of ` +
            `${String(want)} characters, or drop it and let the pack draw its own.`,
          code: 'TDC276',
        });
      }
      continue;
    }

    const suggestion = closestMatch(name, [...declared]);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `"${name}" is not a parameter of "${path}" — it would be ignored`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint:
        declared.size > 0
          ? `Parameters of this generator: ${formatCandidates([...declared])}.`
          : `This generator takes no parameters — it produces a fixed shape. Value passed: "${attrMap[name] ?? ''}".`,
      code: 'TDC072',
    });
  }
}
