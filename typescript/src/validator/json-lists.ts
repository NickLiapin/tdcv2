/**
 * `| json` on a list — TDC312.
 *
 * A `repeat=` column is a LIST joined into one cell with its separator, and `| json` cannot see
 * that: it reads text. Without its argument it prints the whole cell as one string,
 * `"English;Spanish"`, which is valid JSON and almost never what the config meant. With an
 * argument that is not the column's separator it prints a one-element array. Both run, both
 * produce a file that parses, and the mistake surfaces in whatever reads the file — so `check`
 * says so here, naming the separator to write.
 *
 * Only lists whose separator the config states plainly are known: a `<sequence>` whose single
 * `<gen>` repeats, a pool field of that shape, and the same field read through a reference to the
 * pool (`D.languages`) or on a line walking it (`Doctors.languages`), one nested level included
 * (`Doctors.dept.tags`).
 */

import { type Diagnostic, nodeRange } from '../errors/index.js';
import type { DataElementContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';
import { DEFAULT_SEPARATOR } from '../sequence/repeat.js';

const INTERP_REF = /\$\{\{([^}]*)\}\}/g;

/** The `<sequence>`s of a container, those wrapped in `<uniq>`/`<distinct>` included. */
function sequencesOf(container: OpenCloseElementContext): OpenCloseElementContext[] {
  const out: OpenCloseElementContext[] = [];
  for (const child of contentElements(container.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open') continue;
    const tag = elementName(k.node);
    if (tag === 'sequence') out.push(k.node);
    else if (tag === 'uniq' || tag === 'distinct') out.push(...sequencesOf(k.node));
  }
  return out;
}

/** The attributes of a sequence's only `<gen>`, or undefined when it has none or several. */
function soleGen(seq: OpenCloseElementContext): Record<string, string> | undefined {
  const gens = contentElements(seq.content())
    .map((c) => elementKind(c))
    .filter((k) => (k?.kind === 'self' || k?.kind === 'open') && elementName(k.node) === 'gen');
  if (gens.length !== 1) return undefined;
  const k = gens[0];
  return k && (k.kind === 'self' || k.kind === 'open') ? extractAttrs(k.node.attr()) : undefined;
}

/** Every list a `${{…}}` can name, by the path it is named with, and its separator. */
export function collectListSeparators(
  env: OpenCloseElementContext | undefined,
): Map<string, string> {
  const lists = new Map<string, string>();
  if (!env) return lists;
  const poolLists = new Map<string, Map<string, string>>();

  const listsOf = (sequences: OpenCloseElementContext[]): Map<string, string> => {
    const own = new Map<string, string>();
    for (const seq of sequences) {
      const name = (extractAttrs(seq.attr())['name'] ?? '').trim();
      const gen = soleGen(seq);
      if (name === '' || !gen) continue;
      if ((gen['repeat'] ?? '').trim() !== '') {
        own.set(name, gen['separator'] ?? DEFAULT_SEPARATOR);
      } else if (gen['type'] === 'pool') {
        // A record drawn from another pool carries that pool's lists one level down.
        for (const [field, sep] of poolLists.get((gen['value'] ?? '').trim()) ?? []) {
          own.set(`${name}.${field}`, sep);
        }
      }
    }
    return own;
  };

  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open' || elementName(k.node) !== 'pool') continue;
    const pool = (extractAttrs(k.node.attr())['name'] ?? '').trim();
    if (pool === '') continue;
    const own = listsOf(sequencesOf(k.node));
    poolLists.set(pool, own);
    for (const [field, sep] of own) lists.set(`${pool}.${field}`, sep);
  }
  for (const [path, sep] of listsOf(sequencesOf(env))) lists.set(path, sep);
  return lists;
}

/**
 * A separator `json:` can carry. The argument is trimmed, a `|` starts the next filter and a `}`
 * ends the reference, so a list joined with any of those cannot be named after the colon.
 */
function writable(separator: string): boolean {
  return separator.trim() !== '' && !separator.includes('|') && !separator.includes('}');
}

/**
 * TDC312 for each `${{List | json}}` in one `<data>` that does not split on the list's separator.
 *
 * `walked` are the lists an `each` line and its groups walk: there a name is the current ELEMENT.
 */
export function checkJsonLists(
  text: string,
  node: DataElementContext,
  inject: string,
  lists: ReadonlyMap<string, string>,
  diagnostics: Diagnostic[],
  walked: readonly string[] = [],
): void {
  if (inject !== '${{%}}' || lists.size === 0) return;
  for (const m of text.matchAll(INTERP_REF)) {
    const [rawName, ...pieces] = (m[1] ?? '').split('|');
    const name = (rawName ?? '').trim();
    const separator = lists.get(name);
    if (separator === undefined || walked.includes(name)) continue;
    for (const piece of pieces) {
      const colon = piece.indexOf(':');
      if ((colon < 0 ? piece : piece.slice(0, colon)).trim() !== 'json') continue;
      const arg = colon < 0 ? undefined : piece.slice(colon + 1).trim();
      // `json:` with nothing after it is TDC273's to report, and one complaint is enough.
      if (arg === '') continue;
      const want = separator.trim();
      if (arg === want) continue;
      diagnostics.push({
        severity: 'warning',
        source: 'validator',
        ...nodeRange(node),
        message:
          arg === undefined
            ? `"${name}" is a list joined with "${separator}", and | json prints it as one string`
            : `| json:${arg} splits on "${arg}", but "${name}" is joined with "${separator}"`,
        hint: writable(separator)
          ? `Write \${{${name} | json:${want}}} for a JSON array of its elements.`
          : `"${separator}" cannot be written after json: — give the list another separator=, such as ";".`,
        code: 'TDC312',
      });
    }
  }
}
