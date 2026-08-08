import { applyMask } from '../format/transforms.js';
import { type Diagnostic, closestMatch, nodeRange } from '../errors/index.js';
import type { DataElementContext } from '../generated/TDCParser.js';

import { BUILTIN_SEQUENCES } from './known.js';
import { checkFilterArg } from './filter-args.js';
import { FILTER_NAMES, isFilterName } from '../format/transforms.js';

/** `${{Name}}` / `${{Name | filter}}` in a `<data>` body. */
const INTERP_REF = /\$\{\{([^}]*)\}\}/g;

/**
 * `${{Nmae}}` with no sequence of that name used to reach the OUTPUT verbatim —
 * the seven characters `${{Nmae}}` landed in the data. In CSV that is at least
 * visibly wrong; in Parquet it goes into a typed UTF8 column and reads like a
 * legitimate string, so nothing downstream can tell. A guide in this repo
 * referenced an undeclared `${{Client}}` and shipped 50 000 rows that way.
 *
 * Only checked in the OUTPUT BLOCK, where every sequence has been registered.
 * A `<data>` inside `<env>` is visited mid-walk, when later declarations do not
 * exist yet, and flagging there would invent errors for valid configs.
 *
 * Escape hatch for deliberately emitting `${{…}}` (generating a config, a
 * GitHub Actions file, a Handlebars template): give `<env>` a different
 * `inject` pattern. This check stands down whenever inject is not the default,
 * so that case is already covered.
 */
export function checkBlockDataRefs(
  text: string,
  node: DataElementContext,
  inject: string,
  declared: readonly string[],
  diagnostics: Diagnostic[],
  /** `_item` / `_item_id` exist only while rendering an `each=` line. */
  eachBuiltins: readonly string[] = [],
  /**
   * Names that are a RECORD rather than a value — a `<gen type="pool">`
   * reference. `${{Doctor}}` names something real and still prints nothing,
   * which is the worst shape a failure can take, so it is named here.
   */
  records: readonly string[] = [],
): void {
  if (inject !== '${{%}}') return;
  for (const m of text.matchAll(INTERP_REF)) {
    const ref = (m[1] ?? '').split('|')[0]?.trim() ?? '';
    if (ref === '') continue;
    if (records.includes(ref)) {
      const fields = declared
        .filter((n) => n.startsWith(`${ref}.`))
        .map((n) => n.slice(ref.length + 1));
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(node),
        message: `"${ref}" draws a whole member from a pool — it has no value of its own to print`,
        hint:
          fields.length === 0
            ? `Read one of its fields: \${{${ref}.field}}.`
            : `Read a field: ${fields.map((f) => `\${{${ref}.${f}}}`).join(', ')}.`,
        code: 'TDC229',
      });
      continue;
    }
    const known = [...declared, ...BUILTIN_SEQUENCES, ...eachBuiltins];
    // The WHOLE reference has to be a name that resolves. A compound field is
    // addressed `Person.FirstName`, and that is one name — checking only the
    // part before the dot leaves `Person.frstName` reaching the output verbatim,
    // which is the failure this check exists to stop. The field name is the more
    // likely typo of the two: the sequence name is right there in `<env>`, while
    // the field names are the ones you invent yourself.
    if (known.includes(ref)) continue;

    // A dot with a known root is a field mistake, and saying so beats repeating
    // the whole reference back: the reader already knows the sequence exists.
    const dot = ref.indexOf('.');
    const root = dot < 0 ? ref : ref.slice(0, dot);
    if (dot >= 0 && known.includes(root)) {
      const fields = known
        .filter((n) => n.startsWith(`${root}.`))
        .map((n) => n.slice(root.length + 1));
      const suggestion = closestMatch(ref.slice(dot + 1), fields);
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(node),
        message:
          fields.length === 0
            ? `"${ref}" — "${root}" has no fields, so this would be printed literally`
            : `"${ref}" is not a field of "${root}" — it would be printed literally`,
        ...(suggestion ? { suggestion: `did you mean "${root}.${suggestion}"?` } : {}),
        hint:
          fields.length === 0
            ? `Reference it as \${{${root}}}. Only a compound or composed <sequence> has fields to address after a dot — a <mix>, a <switch> and a built-in have none.`
            : `Fields of "${root}": ${fields.join(', ')}.`,
        code: 'TDC193',
      });
      continue;
    }

    const suggestion = closestMatch(root, known);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(node),
      message: `"${ref}" is not a declared sequence — it would be printed literally`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint: 'Declare it in <env>, or set a different inject= pattern if you really want the text ${{…}} in the output.',
      code: 'TDC193',
    });
  }
}

export function checkInterpolationFilters(
  text: string,
  node: DataElementContext,
  inject: string,
  diagnostics: Diagnostic[],
): void {
  if (inject !== '${{%}}') return;
  for (const m of text.matchAll(INTERP_REF)) {
    const content = m[1] ?? '';
    if (!content.includes('|')) continue;
    for (const piece of content.split('|').slice(1)) {
      const colon = piece.indexOf(':');
      const kind = (colon < 0 ? piece : piece.slice(0, colon)).trim();
      const arg = colon < 0 ? undefined : piece.slice(colon + 1);

      // A mask with no pattern has nothing to keep, and the engine answered that
      // literally: it returned the empty string and the column came out blank.
      // Every other bare filter is a whole transform on its own — `upper`,
      // `trim`, `csv` — so this one reads like them and is not.
      if (kind === 'mask' && (arg === undefined || arg.trim() === '')) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...nodeRange(node),
          message: 'the "mask" filter needs a pattern — ${{X|mask}} empties the column',
          hint:
            'Write the pattern after a colon: ${{X|mask:xxx-xx}}. `x` keeps a character, `w` ' +
            'keeps a whole word, `*` hides one — see the masks guide.',
          code: 'TDC256',
        });
        continue;
      }

      // The same parse the `mask=` attribute gets. Written as a filter it was
      // reaching the renderer unchecked, which is how a bad index aborted a run
      // with no position to point at.
      if (kind === 'mask' && arg !== undefined) {
        try {
          applyMask(arg, '');
        } catch (err) {
          diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...nodeRange(node),
            message: err instanceof Error ? err.message : String(err),
            hint: 'Indices are 0-based; ranges use "..", e.g. mask:x[0..3] or mask:w[-1], w[0].',
            code: 'TDC199',
          });
        }
        continue;
      }

      if (kind && !isFilterName(kind)) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...nodeRange(node),
          message: `unknown interpolation filter "${kind}"`,
          hint: `Supported: ${FILTER_NAMES.join(', ')}.`,
          code: 'TDC192',
        });
        continue;
      }

      // The name is known. Now the part after the colon, which reached the
      // renderer unread until TDC273/TDC274/TDC275.
      checkFilterArg(kind, arg, node, diagnostics);
    }
  }
}
