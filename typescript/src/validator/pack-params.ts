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
  packParams: PackParams | undefined,
  diagnostics: Diagnostic[],
): void {
  const declared = packParams?.get(path);
  if (!declared) return;

  for (const attr of attrs) {
    const name = attr._attrName?.text;
    if (!name || GEN_ATTRIBUTES.has(name) || declared.has(name)) continue;

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
