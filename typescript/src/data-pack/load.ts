/**
 * Data-pack loader.
 *
 * Recursively scans one or more root directories, parses every file as a
 * data pack (see parse.ts), and builds a registry mapping a dotted
 * address to its list of values.
 *
 * Addressing (docs/superpowers/specs/2026-07-14-data-packs-design.md):
 *   - Default: derived from the file's path relative to its scan root —
 *     `person/es/man/firstName.txt` -> `person.es.man.firstName`
 *     (folder names become dotted segments, filename is the last segment,
 *     extension ignored).
 *   - Override: a `---`-fenced header may declare `address:` explicitly,
 *     for files that sit loose in the root or need an address that does
 *     not match their folder tree (e.g. `scifi.ship.color`).
 *
 * Two files resolving to the same address is an error — the loader does
 * not guess a winner. Loading never throws; problems are returned as
 * diagnostics for the caller (TDC / CLI) to surface.
 */

import { type Dirent, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Diagnostic } from '../errors/index.js';
import { loadFileValues, parseDelimiter } from '../generators/file.js';
import { loadWeightedValues } from '../generators/weighted.js';
import { templatePathKnown } from '../validator/known.js';

import { type GeneratorBody, parseGeneratorSpec } from './generator.js';
import { parameterWidths } from './param-width.js';
import {
  CANONICAL_LOCALES,
  noteNamespace,
  RESERVED_BUCKETS,
  MANIFEST_FILENAME,
  parseLocaleManifest,
  type LocaleManifest,
} from './locales.js';
import { parsePackFile as parseContent } from './parse.js';

export interface PackEntry {
  /** Dotted address the list is reachable by, e.g. `person.es.man.firstName`. */
  readonly address: string;
  /**
   * Data-list entry: the values to uniform-pick from. Present iff this is
   * a data pack (not a generator).
   */
  readonly values?: readonly string[] | undefined;
  /**
   * Per-value share in percent, parallel to `values`, summing to 100. Present
   * only for a WEIGHTED data list (header `weighted: true`, or `file:` with a
   * `weight:` column). When set, the pack is drawn to an exact Hamilton quota
   * instead of uniformly — so `Smith` appears as often as it does in the Census,
   * not as often as `Zabrowski`. Absent → uniform, unchanged.
   */
  readonly percents?: readonly number[] | undefined;
  /**
   * Generator entry: a parsed generator body (single primitive `<gen>`,
   * or composed local sequences + `<data>` output), executed by the
   * engine to produce values. Present iff the pack file declared a
   * `generator:` header. Exactly one of `values` / `generator` is set.
   */
  readonly generator?: GeneratorBody | undefined;
  /** Addresses this generator references (for load-time validation). */
  readonly references?: readonly string[] | undefined;
  /**
   * The generator's value is only correct across a whole column, so it must not
   * be resolved a row at a time.
   *
   * Two ways to earn it. The generator may declare a share itself (`<mix
   * percent>` / `percent=`), which `parseGeneratorSpec` sees in the body. Or it
   * may DRAW from a weighted list, which the body does not say and only the
   * loaded registry knows — see `propagateWholeColumn`.
   */
  readonly needsWholeColumn?: boolean | undefined;
  /** Human-readable description from the header, if any. */
  readonly description?: string | undefined;
  /** Locale tag from the header, if any. */
  readonly locale?: string | undefined;
  /** Absolute path of the file that produced this entry (for diagnostics). */
  readonly sourceFile: string;
}

export type PackRegistry = ReadonlyMap<string, PackEntry>;

export interface ScanResult {
  readonly registry: PackRegistry;
  readonly locales: ReadonlyMap<string, LocaleManifest>;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Scans already done in this process, keyed by the roots they were given.
 *
 * Reading 3957 bundled addresses off disk costs ~220 ms, while parsing and
 * validating a config costs ~2 ms — so a program that builds several `TDC`
 * objects spends nearly all of its time re-reading files that did not change.
 * The CLI is one process per run and never notices; a test suite, an editor,
 * and the quick API all build many.
 */
const scans = new Map<string, ScanResult>();

/**
 * Forget every cached scan.
 *
 * Needed by anything that installs packs and keeps running — `tdcv2 pack add`
 * inside a long-lived process, or a test that writes into a root it has already
 * scanned. A fresh process starts empty, so ordinary runs never call this.
 */
export function clearPackCache(): void {
  scans.clear();
}

/**
 * Scan the given root directories and build a pack registry. Roots that
 * do not exist are skipped silently (so an absent bundled folder in a
 * published package is not an error). Directory entries are walked in
 * sorted order for deterministic diagnostics.
 *
 * The result is cached per root list for the life of the process; the returned
 * maps are shared, so callers must treat them as read-only.
 */
export function scanPacks(roots: readonly string[]): ScanResult {
  const key = roots.join(' ');
  const cached = scans.get(key);
  if (cached) return cached;
  const result = scanPacksFromDisk(roots);
  scans.set(key, result);
  return result;
}

function scanPacksFromDisk(roots: readonly string[]): ScanResult {
  const registry = new Map<string, PackEntry>();
  const locales = new Map<string, LocaleManifest>();
  const diagnostics: Diagnostic[] = [];
  // Which root (by priority index) each address came from. Roots are given
  // LOW→HIGH priority, so a LATER root shadows an earlier one for the same
  // address — that is how a downloaded or project pack overrides the bundled
  // one. A collision WITHIN a single root is still a real mistake and errors.
  const rootOf = new Map<string, number>();

  roots.forEach((root, rootIndex) => {
    if (!isDirectory(root)) return;
    loadLocaleManifests(root, locales);
    for (const file of walkFiles(root)) {
      loadOne(root, rootIndex, file, registry, rootOf, diagnostics);
    }
  });

  // Second pass: now that every address is registered, validate generator
  // references — each must resolve to a data list, another generator, or a
  // builtin template; and generator-to-generator references must be acyclic
  // (a cycle would recurse forever at render time).
  validateGeneratorReferences(registry, diagnostics);

  // Third pass: a generator that DRAWS from a weighted list is a whole-column
  // quota too, and only the finished registry can tell.
  propagateWholeColumn(registry);

  return { registry, locales, diagnostics };
}

/**
 * A generator that draws from a weighted list is whole-column, transitively.
 *
 * A weighted list is laid out to an exact Hamilton quota over the run: `Kovács`
 * takes its measured share of the rows, not a uniform one. That is a plan for a
 * COLUMN. Asked for one row, the plan is computed over a column of one and the
 * single row goes to the largest share — the same failure `percent=` has, in a
 * place nothing was looking.
 *
 * It cost five shipped locales their full names. `hu.person.male.fullName` is a
 * pack generator whose body draws `hu.person.lastName` and
 * `hu.person.male.firstName`, both weighted; a config asking for eight Hungarian
 * names got `Nagy László` eight times, on every engine, for every seed. Czech,
 * Dutch, Persian and Hebrew were in the same state, and German, Spanish and
 * Polish were not — the only difference being that their name lists carry no
 * weights. Handed the whole count the very same generator returns eight
 * different names, so nothing was wrong with the pack or the data.
 *
 * `parseGeneratorSpec` cannot see this: it reads one body, and whether
 * `hu.person.lastName` is weighted is a fact about a different file that may not
 * be loaded yet. So it is decided here, once every address is registered, and
 * from there the existing machinery does the rest — `perRowBuildable` stops
 * taking the row-at-a-time path, the router sends the config to the in-memory
 * engine, and a forced streaming engine refuses with a message instead of
 * quietly repeating one name.
 */
function propagateWholeColumn(registry: Map<string, PackEntry>): void {
  /** Memoised answers. A cycle is already reported above, so it resolves false. */
  const answered = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isWholeColumn = (address: string): boolean => {
    const cached = answered.get(address);
    if (cached !== undefined) return cached;
    const entry = registry.get(address);
    if (!entry) return false;
    // A weighted DATA list is the leaf this walk is looking for.
    if (entry.percents !== undefined) return true;
    if (!entry.generator) return false;
    if (visiting.has(address)) return false;
    visiting.add(address);
    const answer =
      entry.needsWholeColumn === true || (entry.references ?? []).some((ref) => isWholeColumn(ref));
    visiting.delete(address);
    answered.set(address, answer);
    return answer;
  };

  for (const [address, entry] of registry) {
    if (!entry.generator || entry.needsWholeColumn === true) continue;
    if (isWholeColumn(address)) registry.set(address, { ...entry, needsWholeColumn: true });
  }
}

/**
 * Read `<root>/<code>/_locale.json` for each top-level directory and record its
 * parsed manifest. Directories without a manifest are not locales here (e.g.
 * the reserved `common` bucket).
 */
function loadLocaleManifests(root: string, into: Map<string, LocaleManifest>): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(root, entry.name, MANIFEST_FILENAME);
    let content: string;
    try {
      content = readFileSync(manifestPath, 'utf8');
    } catch {
      continue; // no manifest -> not a locale folder
    }
    into.set(entry.name, parseLocaleManifest(content, entry.name));
  }
}

function validateGeneratorReferences(
  registry: ReadonlyMap<string, PackEntry>,
  diagnostics: Diagnostic[],
): void {
  // 1. Every reference must resolve somewhere. Data lists and generators
  //    live in the registry; the rest must be a known builtin template.
  const addresses = [...registry.keys()];
  for (const entry of registry.values()) {
    if (!entry.references) continue;
    for (const ref of entry.references) {
      // Resolvable as a hard/soft pack address or a builtin template.
      if (templatePathKnown(ref, addresses)) continue;
      diagnostics.push(
        packError(
          `generator "${entry.address}" references unknown address "${ref}"`,
          entry.sourceFile,
        ),
      );
    }
  }
  // 2. Generator-to-generator references are allowed but must be acyclic.
  detectGeneratorCycles(registry, diagnostics);
}

/**
 * Detect cycles in the generator-to-generator reference graph (a data list
 * is a leaf, so only generator→generator edges can close a loop). Reports
 * one diagnostic per distinct cycle. Iterative-safe: generator graphs are
 * tiny. Addresses are visited in sorted order for deterministic output.
 */
function detectGeneratorCycles(
  registry: ReadonlyMap<string, PackEntry>,
  diagnostics: Diagnostic[],
): void {
  const generatorAddresses = [...registry.keys()]
    .filter((addr) => registry.get(addr)?.generator)
    .sort();

  const generatorNeighbors = (addr: string): string[] => {
    const refs = registry.get(addr)?.references ?? [];
    return refs.filter((ref) => registry.get(ref)?.generator !== undefined);
  };

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (addr: string): void => {
    color.set(addr, GRAY);
    stack.push(addr);
    for (const neighbor of generatorNeighbors(addr)) {
      const c = color.get(neighbor) ?? WHITE;
      if (c === GRAY) {
        // Back-edge: the cycle is the stack slice from `neighbor` onward.
        const cycle = stack.slice(stack.indexOf(neighbor));
        const key = [...cycle].sort().join('\u0000');
        if (!reported.has(key)) {
          reported.add(key);
          diagnostics.push(
            packError(
              `generator reference cycle: ${[...cycle, neighbor].join(' → ')}`,
              registry.get(neighbor)?.sourceFile ?? '',
            ),
          );
        }
      } else if (c === WHITE) {
        visit(neighbor);
      }
    }
    stack.pop();
    color.set(addr, BLACK);
  };

  for (const addr of generatorAddresses) {
    if ((color.get(addr) ?? WHITE) === WHITE) visit(addr);
  }
}

function loadOne(
  root: string,
  rootIndex: number,
  file: string,
  registry: Map<string, PackEntry>,
  rootOf: Map<string, number>,
  diagnostics: Diagnostic[],
): void {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    diagnostics.push(packError(`cannot read data-pack file "${file}"`, file));
    return;
  }

  // Lazy import avoids a cycle (parse has no deps on this module).
  const parsed = parseContent(content);

  const declaredAddress = parsed.header['address'];
  let address = declaredAddress ?? pathToAddress(root, file);
  if (address.length === 0) {
    diagnostics.push(packError(`data-pack file "${file}" resolves to an empty address`, file));
    return;
  }

  /** The first addressable segment the FILE'S OWN PATH yields. */
  const pathHead = pathToAddress(root, file).split('.')[0] ?? '';

  /**
   * Is this address one the tree itself accounts for?
   *
   * This used to be a membership test against a list of countries COMPILED INTO
   * THE LIBRARY, and that made the data version-bound: a country pack written
   * after a release was unknown to every installed copy, so its files were
   * refused and — worse — its mere presence in the store made unrelated configs
   * emit this warning. Packs are meant to be independent of the engine; a list
   * inside the engine is the one thing that cannot be.
   *
   * So placement is now STRUCTURAL. A directory under `countries/` names a
   * country because of where it is, not because someone added the word to a
   * Set, and the same is true of any other top-level grouping the data grows
   * later. Locales stay a list only because THAT list is fixed: it mirrors
   * moment.js and does not grow with the data.
   *
   * What the old check really protected against is kept below: an address the
   * author DECLARED is never silently re-homed.
   */
  const placed = (candidate: string): boolean => {
    const head = candidate.split('.')[0] ?? '';
    if (head.length === 0) return false;
    // An address the author WROTE DOWN is the author's to choose. Refusing it
    // because the library had not heard of its first segment is what made the
    // data version-bound; a pack that says where it belongs belongs there.
    if (declaredAddress !== undefined) return true;
    if (CANONICAL_LOCALES.has(head) || RESERVED_BUCKETS.has(head)) return true;
    if (pathHead !== head) return false;
    // Placed by location. `countries/` is a grouping the tree already has, and
    // its folders name themselves — no list required, and no header either,
    // because the location alone is unambiguous.
    if (isUnderCountries(root, file)) return true;
    /*
     * Any OTHER top-level FOLDER opens a namespace of its own, so the data can
     * grow shapes nobody has thought of yet without touching five engines.
     *
     * A folder, not a loose file: a `dataPaths` directory also holds raw lists
     * for `@data` — `statuses.txt` beside the packs — and those are not packs.
     * Depth is what separates them, and it is the rule the other four
     * implementations already applied by asking whether the head names a
     * directory. This one asked a list instead, which is why it was the only
     * one where a new country needed a release.
     */
    return rootRelativeDepth(root, file) > 1;
  };

  /*
   * `locale:` on a file with no `address:` still wins over the path.
   *
   * That header is how somebody keeps a flat folder of their own lists instead
   * of rebuilding a locale tree to hold three files: `mylists/colour.txt` with
   * `locale: ru` means `ru.mylists.colour`. Accepting any path head would have
   * silently taken that away — the file would have registered as `mylists.…`
   * and the address the author expected would be gone.
   *
   * It is decided BEFORE placement, because after the change every path is
   * placeable and the old fallback could never fire.
   */
  const headerLocale = (parsed.header['locale'] ?? '').trim();
  if (
    declaredAddress === undefined &&
    headerLocale.length > 0 &&
    !CANONICAL_LOCALES.has(pathHead) &&
    !RESERVED_BUCKETS.has(pathHead) &&
    !isUnderCountries(root, file) &&
    CANONICAL_LOCALES.has(headerLocale)
  ) {
    address = `${headerLocale}.${address}`;
  }

  if (!placed(address)) {
    // The PATH put it nowhere addressable. A header `locale:` is the file's own
    // answer to that — it is how someone keeps a flat folder of their own lists
    // instead of rebuilding the locale tree to hold three files.
    //
    // It is not a licence to rewrite an address the author wrote down. When
    // `turkey` was missing from CANONICAL_COUNTRIES, every Turkey pack file
    // said `address: turkey.geo.city` and carried `locale: tr` — because its
    // VALUES are Turkish — and the fallback silently re-homed them to
    // `tr.turkey.geo.city`: country data inside the Turkish LANGUAGE namespace,
    // at an address nothing asks for and nobody wrote. The files that failed
    // loudly were the ones with no `locale:` at all, so the better a pack was
    // labelled, the quieter it broke.
    //
    // So the fallback now applies only to a path-derived address. A declared
    // one that lands nowhere is a mistake to report, not to paper over.
    const declaredLocale = (parsed.header['locale'] ?? '').trim();
    if (
      declaredAddress === undefined &&
      declaredLocale.length > 0 &&
      placed(`${declaredLocale}.${address}`)
    ) {
      address = `${declaredLocale}.${address}`;
    } else if (parsed.hasHeader) {
      // It carries pack metadata, so it was meant as a pack — saying nothing
      // would leave the author with "unknown template path" about a file the
      // scan read and dropped. A file with no header at all stays silent: it is
      // probably a raw `@data` source, not a pack.
      diagnostics.push(
        packWarning(
          `data-pack file "${file}" is not addressable: "${address}" does not match where ` +
            'the file is, and its first segment is not a known locale. A folder opens a ' +
            'namespace of its own — move the file into one, or give it an `address:` or a ' +
            '`locale:` that says where it belongs.',
          file,
        ),
      );
      return;
    } else {
      return;
    }
  }

  // A `generator:` header means the body is a TDC-DSL generator (a single
  // primitive <gen>, or local sequences + <data> output), not a data list.
  let payload: {
    values?: readonly string[];
    percents?: readonly number[];
    generator?: GeneratorBody;
    references?: readonly string[];
    needsWholeColumn?: boolean;
  };
  if (parsed.header['generator'] !== undefined) {
    const body = parsed.values.join('\n').trim();
    if (body.length === 0) {
      diagnostics.push(packError(`generator "${address}" (${file}) has an empty body`, file));
      return;
    }
    const result = parseGeneratorSpec(body, parsed.header['inject']);
    if (result.generator === undefined) {
      diagnostics.push(
        packError(`generator "${address}" (${file}): ${result.error ?? 'invalid body'}`, file),
      );
      return;
    }
    payload = {
      generator: result.generator.body,
      references: result.generator.references,
      needsWholeColumn: result.generator.needsWholeColumn,
    };
  } else {
    let values: readonly string[];
    let percents: readonly number[] | undefined;
    const externalFile = parsed.header['file'];
    const weightColumn = parsed.header['weight'];
    if (externalFile !== undefined) {
      const externalPath = resolve(dirname(file), externalFile);
      try {
        if (weightColumn !== undefined && weightColumn.trim() !== '') {
          // Weighted external CSV: the same loader `weight=` uses on a config's
          // own file, so the proportions are read and honoured identically.
          const w = loadWeightedValues(
            externalPath,
            {
              column: parsed.header['column'],
              delimiter: parsed.header['delimiter'],
            },
            weightColumn.trim(),
          );
          values = w.values;
          percents = w.percents;
        } else {
          values = loadFileValues(externalPath, {
            column: parsed.header['column'],
            delimiter: parsed.header['delimiter'],
          });
        }
      } catch (err) {
        diagnostics.push(
          packError(
            `data-pack file "${file}" references unreadable data file "${externalPath}"` +
              (err instanceof Error ? `: ${err.message}` : ''),
            file,
          ),
        );
        return;
      }
    } else if (parsed.header['weighted'] === 'true') {
      // Inline weighted body: each line is `value<delimiter>count`. The pack IS
      // the data, no external file. The separator defaults to a comma but can
      // be set with `delimiter:` (any single char, or an alias like `tab`) so a
      // value that itself contains commas — a sentence, a notification — is not
      // torn apart. Split on the LAST occurrence, so the value keeps its own.
      let delimiter: string;
      try {
        delimiter = parseDelimiter(parsed.header['delimiter']);
      } catch {
        diagnostics.push(
          packError(
            `weighted pack "${address}" (${file}): delimiter "${parsed.header['delimiter'] ?? ''}" ` +
              `must be one character or an alias (comma, semicolon, tab, pipe)`,
            file,
          ),
        );
        return;
      }
      const parsedWeighted = parseWeightedBody(
        parsed.values,
        delimiter,
        address,
        file,
        diagnostics,
      );
      if (!parsedWeighted) return; // a diagnostic was pushed
      values = parsedWeighted.values;
      percents = parsedWeighted.percents;
    } else {
      values = parsed.values;
    }
    if (values.length === 0) {
      diagnostics.push(packError(`data-pack address "${address}" (${file}) has no values`, file));
      return;
    }
    payload = percents ? { values, percents } : { values };
  }

  const existing = registry.get(address);
  if (existing) {
    const prevRoot = rootOf.get(address) ?? rootIndex;
    if (prevRoot === rootIndex) {
      // Two files in the SAME root claim one address — a genuine mistake.
      diagnostics.push(
        packError(
          `duplicate data-pack address "${address}" declared by both ` +
            `"${existing.sourceFile}" and "${file}" — rename or move one`,
          file,
        ),
      );
      return;
    }
    // A higher-priority root (later in the list) shadows the earlier one. Fall
    // through to register the new entry, replacing the shadowed one.
  }

  rootOf.set(address, rootIndex);
  // The tree just told us this namespace exists; remember it so an address
  // starting with it is read as absolute rather than prefixed with a locale.
  noteNamespace(address.split('.')[0] ?? '');
  registry.set(address, {
    address,
    ...payload,
    description: parsed.header['description'],
    locale: parsed.header['locale'],
    sourceFile: file,
  });
}

/**
 * Convert a file's path (relative to its scan root) to a dotted address:
 * strips the final extension, splits on the path separator, joins with
 * dots. `person/es/man/firstName.txt` -> `person.es.man.firstName`.
 */
/** How many path segments deep the file sits below the pack root. */
function rootRelativeDepth(root: string, file: string): number {
  let rel = file.startsWith(root) ? file.slice(root.length) : file;
  while (rel.startsWith(sep) || rel.startsWith('/')) rel = rel.slice(1);
  return rel.split(/[\\/]/).filter((s) => s.length > 0).length;
}

/** Does this file sit under the tree's `countries/` grouping? */
function isUnderCountries(root: string, file: string): boolean {
  let rel = file.startsWith(root) ? file.slice(root.length) : file;
  while (rel.startsWith(sep) || rel.startsWith('/')) rel = rel.slice(1);
  return rel.split(/[\\/]/)[0] === 'countries';
}

export function pathToAddress(root: string, file: string): string {
  let rel = file.startsWith(root) ? file.slice(root.length) : file;
  // Drop leading separator(s).
  while (rel.startsWith(sep) || rel.startsWith('/')) rel = rel.slice(1);
  const ext = extname(rel);
  if (ext.length > 0) rel = rel.slice(0, -ext.length);
  const dotted = rel
    .split(/[\\/]/)
    .filter((seg) => seg.length > 0)
    .join('.');
  // The `countries/` folder is a physical grouping (for the UI's country
  // picker); the country name is the address's first segment —
  // `countries/usa/tax/ssn` -> `usa.tax.ssn`, not `countries.usa.tax.ssn`.
  return dotted.startsWith('countries.') ? dotted.slice('countries.'.length) : dotted;
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    // Push directories in reverse so the sorted order is preserved on pop.
    const dirs: string[] = [];
    for (const entry of names) {
      if (isIgnoredEntry(entry.name)) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) dirs.push(full);
      else if (entry.isFile() && isPackFile(entry.name)) out.push(full);
    }
    for (let k = dirs.length - 1; k >= 0; k--) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      stack.push(dirs[k]!);
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Skip files/dirs that are clearly not data: dotfiles (`.DS_Store`,
 * `.gitkeep`, `.git`), and common repo docs (README/LICENSE/CHANGELOG)
 * regardless of extension. Applies to directories too, so it must not
 * look at extensions — that is `isPackFile`'s job.
 */
function isIgnoredEntry(name: string): boolean {
  if (name === MANIFEST_FILENAME) return true;
  if (name.startsWith('.')) return true;
  const base = name.toLowerCase().replace(/\.[^.]+$/, '');
  return base === 'readme' || base === 'license' || base === 'changelog';
}

/**
 * The two extensions a pack FILE can carry: `.txt` for a list or a generator
 * written in a header, `.tdc` for a generator written as a config.
 *
 * This used to be an allow-everything rule — the spec said the extension of a
 * data file is ignored — and that was written before a pack carried anything
 * but data. Once `DATE_LOCALE.json` arrived, fifteen locales silently grew an
 * address (`bn.DATE_LOCALE`, `hu.DATE_LOCALE`, …) whose values were the lines
 * of the JSON source: `{`, `"months": [`, `"Január",`. No diagnostic, because
 * nothing was malformed — a file was read as a list, which is exactly what the
 * loader was told to do with any file it found.
 *
 * An allowlist rather than a `.json` denylist: the next metadata file to be
 * added should not have to remember to come here first.
 */
const PACK_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['.txt', '.tdc']);

function isPackFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && PACK_FILE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A pack file the scan read and could not address. A warning rather than an
 * error: the run continues on everything else, and the author hears about the
 * file instead of meeting it later as "unknown template path".
 */
function packWarning(message: string, file: string): Diagnostic {
  return {
    severity: 'warning',
    source: 'pack',
    line: 1,
    column: 0,
    message,
    hint: `Data pack file: ${file}`,
    code: 'TDC171',
  };
}

function packError(message: string, file: string): Diagnostic {
  return {
    severity: 'error',
    source: 'pack',
    line: 1,
    column: 0,
    message,
    hint: `Data pack file: ${file}`,
    code: 'TDC170',
  };
}

/**
 * Where the packs a run starts from live — the same three questions, in the same
 * order, in all five implementations:
 *
 *   1. `TDCV2_PACKS`, if it names a directory. Written down by hand, so it wins.
 *   2. The TDC source checkout this build came from, if there is one — see
 *      {@link sourceCheckoutPacks}. In a checkout that is the copy every
 *      implementation reads and the one a contributor edits, so all five see the
 *      same data rather than five drifting copies.
 *   3. The starter set shipped inside the package.
 *
 * Whatever `tdcv2.config.json` and `--data-path` name is layered on top of the
 * answer, not instead of it.
 *
 * For step 3 two layouts have to work, and checking only one is what once made an
 * installed package unable to generate a single name:
 *
 *   - **installed** — `<package>/data/packs`, copied in at pack time. From
 *     `dist/data-pack` that is two levels up.
 *   - **in the repo** — `<repo>/data/packs`, three levels up from
 *     `typescript/dist/data-pack` (or `typescript/src/data-pack` under tsx).
 *
 * The installed layout is checked first so a stale copy left inside the package
 * cannot be shadowed by the repo copy, and so the common case costs one stat.
 */
export function bundledPacksDir(): string | undefined {
  const fromEnv = process.env['TDCV2_PACKS'];
  if (fromEnv !== undefined && fromEnv.trim() !== '' && isDirectory(fromEnv)) return fromEnv;

  const here = dirname(fileURLToPath(import.meta.url));
  const checkout = sourceCheckoutPacks(here);
  if (checkout !== undefined) return checkout;

  const candidates = [
    resolve(here, '..', '..', 'data', 'packs'),
    resolve(here, '..', '..', '..', 'data', 'packs'),
  ];
  return candidates.find((c) => isDirectory(c));
}

/**
 * `<repo>/data/packs`, if this code is running out of a TDC source checkout.
 *
 * Walking up for a bare `data/packs` is not enough: that name is ordinary enough
 * that an unrelated folder above an installed package could answer, and then the
 * same config would read different data depending on where the user happened to
 * install it. A directory only counts when it ALSO holds `fixtures/cross-language`
 * — the folder that holds the contract all five implementations are tested
 * against, which exists in this repository and nowhere else.
 */
export function sourceCheckoutPacks(startFrom: string): string | undefined {
  let current = resolve(startFrom);
  for (;;) {
    if (isDirectory(join(current, 'fixtures', 'cross-language'))) {
      const packs = join(current, 'data', 'packs');
      if (isDirectory(packs)) return packs;
    }
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
}

let bundledPacksCache: PackRegistry | undefined;

/**
 * The bundled data packs, scanned once and cached. Used as the default pack
 * source for the public render/object entry points and the JS facade, so
 * `person.male.firstName` and friends resolve with zero configuration. Empty
 * map if the bundled directory is absent (a trimmed published package).
 */
export function bundledPacks(): PackRegistry {
  if (bundledPacksCache === undefined) {
    const dir = bundledPacksDir();
    bundledPacksCache = dir ? scanPacks([dir]).registry : new Map();
  }
  return bundledPacksCache;
}

/**
 * Address → the parameter names each generator pack accepts.
 *
 * A pack's parameters ARE its local `<sequence>` names: `tax_office="7712"`
 * replaces the sequence called `tax_office`. A single-`<gen>` pack has none, and
 * a data-list pack is not a generator at all, so neither appears here — passing
 * anything to those is always a no-op. Consumed by the validator.
 */
export function packParameterNames(packs: PackRegistry): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>();
  for (const [address, entry] of packs) {
    const body = entry.generator;
    // Every KNOWN address gets an entry, including the plain lists. A list has no
    // parameters at all, so an attribute aimed at one does nothing — and an
    // attribute that does nothing is indistinguishable from a typo, which is the
    // whole reason this check exists. Leaving them out meant `<gen
    // type="template" value="person.lastName" domain="x"/>` ran without a word
    // here while the ports refused it.
    //
    // An address this run cannot resolve is still absent, and the caller stays
    // silent about those: guessing there would produce false errors.
    out.set(
      address,
      body?.kind === 'composed' ? new Set(body.sequences.map((s) => s.name)) : new Set<string>(),
    );
  }
  return out;
}

/**
 * Address → the widths its parameters always produce, where that is provable.
 *
 * Only composed packs have parameters, and only some of their sequences have a
 * width that can be read off the spec. An address absent from the inner map
 * simply has no proven width, and the caller must stay silent about it.
 */
export function packParameterWidths(
  packs: PackRegistry,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const out = new Map<string, ReadonlyMap<string, number>>();
  for (const [address, entry] of packs) {
    const body = entry.generator;
    if (body?.kind === 'composed') out.set(address, parameterWidths(body.sequences));
  }
  return out;
}

/**
 * Split an inline weighted body (`weighted: true`) into parallel values and
 * percents. Each line is `value<delimiter>count` where count is a non-negative
 * integer; the split is on the LAST occurrence of the delimiter, so a value may
 * contain it (a value with commas can still use the default comma delimiter, as
 * long as the count comes last).
 *
 * A blank count is a hard error, not a silent zero — the same rule `weight=`
 * enforces on a file — because `Number('')` is 0 and would delete the value
 * without a word. An explicit 0 drops the value (never drawn). Returns
 * undefined after pushing a diagnostic, so the caller aborts this pack.
 */
function parseWeightedBody(
  lines: readonly string[],
  delimiter: string,
  address: string,
  file: string,
  diagnostics: Diagnostic[],
): { values: string[]; percents: number[] } | undefined {
  const values: string[] = [];
  const counts: number[] = [];
  let total = 0;
  const shown = delimiter === '\t' ? 'tab' : delimiter;
  for (const line of lines) {
    const cut = line.lastIndexOf(delimiter);
    if (cut < 0) {
      diagnostics.push(
        packError(
          `weighted pack "${address}" (${file}): line "${line}" has no "${shown}count" — ` +
            `each line of a weighted pack is "value${shown}count"`,
          file,
        ),
      );
      return undefined;
    }
    const value = line.slice(0, cut).trim();
    const raw = line.slice(cut + delimiter.length).trim();
    if (value === '') continue;
    if (raw === '') {
      diagnostics.push(
        packError(
          `weighted pack "${address}" (${file}): value "${value}" has an empty count — ` +
            `write 0 to exclude it, or give a number`,
          file,
        ),
      );
      return undefined;
    }
    const weight = Number(raw);
    if (!Number.isFinite(weight) || weight < 0 || !Number.isInteger(weight)) {
      diagnostics.push(
        packError(
          `weighted pack "${address}" (${file}): count "${raw}" for "${value}" ` +
            `is not a non-negative integer`,
          file,
        ),
      );
      return undefined;
    }
    if (weight === 0) continue; // never drawn — carry nothing
    values.push(value);
    counts.push(weight);
    total += weight;
  }
  if (values.length === 0) {
    diagnostics.push(
      packError(`weighted pack "${address}" (${file}) has no values with a positive count`, file),
    );
    return undefined;
  }
  return { values, percents: counts.map((c) => (c / total) * 100) };
}
