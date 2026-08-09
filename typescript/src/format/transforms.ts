/**
 * Output text formatting — case transforms + positional mask.
 *
 * Pure string → string functions shared by three call sites: `compute` tags
 * (`<upper>`/`<mask>`/…), `<gen>` `case=`/`mask=` attributes, and `${{… | …}}`
 * interpolation filters. See
 * docs/specs/2026-07-18-output-formatting-and-ordering-design.md.
 */

export const CASE_TRANSFORMS = ['upper', 'lower', 'capitalize', 'title'] as const;

/**
 * Build the per-value formatter for a gen's `mask=`/`case=` attributes (mask
 * first, then case), or `undefined` if neither applies. Used as a post-processor
 * in both the in-memory and streaming engines.
 */
export function genFormatter(
  mask: string | undefined,
  kase: string | undefined,
): ((v: string) => string) | undefined {
  const hasMask = mask !== undefined;
  const hasCase = kase !== undefined && isCaseTransform(kase);
  if (!hasMask && !hasCase) return undefined;
  return (v: string): string => {
    let out = v;
    if (hasMask) out = applyMask(mask, out);
    if (hasCase) out = applyCase(kase, out);
    return out;
  };
}

export type CaseTransform = (typeof CASE_TRANSFORMS)[number];

/** True if `name` is one of the four case transforms. */
export function isCaseTransform(name: string): name is CaseTransform {
  return (CASE_TRANSFORMS as readonly string[]).includes(name);
}

function upperFirst(word: string): string {
  const cp = Array.from(word);
  if (cp.length === 0) return word;
  return (cp[0] ?? '').toUpperCase() + cp.slice(1).join('');
}

/** Apply a case transform. `capitalize`/`title` leave non-first chars unchanged. */
export function applyCase(name: string, s: string): string {
  switch (name) {
    case 'upper':
      return s.toUpperCase();
    case 'lower':
      return s.toLowerCase();
    case 'capitalize':
      return upperFirst(s);
    case 'title':
      return s.replace(/\S+/gu, (w) => upperFirst(w));
    default:
      throw new Error(`unknown case transform "${name}"`);
  }
}

/** Substring by code-point index, `[from, to)`; `to` omitted means to the end. */
export function applySlice(s: string, from: number, to?: number): string {
  const cp = Array.from(s);
  const f = Number.isFinite(from) ? from : 0;
  const t = to === undefined || !Number.isFinite(to) ? cp.length : to;
  return cp.slice(f, t).join('');
}

/** Replace every occurrence of `from` with `to`. */
export function applyReplace(s: string, from: string, to: string): string {
  return from === '' ? s : s.split(from).join(to);
}

/** Strip leading/trailing whitespace. */
export function applyTrim(s: string): string {
  return s.trim();
}

/** Group characters from the RIGHT into chunks of `size`, joined by `sep`. */
export function applyGroup(s: string, size: number, sep: string): string {
  if (!Number.isFinite(size) || size <= 0 || s.length === 0) return s;
  // A decimal number is grouped where a person groups one: the digits BEFORE
  // the separator, and nowhere else. Chunking the whole string from the right
  // put the space in the fraction — `1234.56` came out `1 234 .56`, which is a
  // number in no locale, and nothing said so. Only this exact shape is treated
  // as a number: `group:4` on a card number stays the blocks it was written for,
  // and so does every other string.
  const decimal = /^([+-]?)(\d+)(\.\d+)$/.exec(s);
  if (decimal) {
    const [, sign = '', whole = '', fraction = ''] = decimal;
    return sign + chunkFromRight(whole, size, sep) + fraction;
  }
  return chunkFromRight(s, size, sep);
}

function chunkFromRight(s: string, size: number, sep: string): string {
  const cp = Array.from(s);
  if (cp.length === 0) return s;
  const out: string[] = [];
  for (let end = cp.length; end > 0; end -= size) {
    out.unshift(cp.slice(Math.max(0, end - size), end).join(''));
  }
  return out.join(sep);
}

function splitFirst(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** All interpolation-filter / formatting names, for validation. */
export const FILTER_NAMES = [
  'upper',
  'lower',
  'capitalize',
  'title',
  'mask',
  'slice',
  'replace',
  'trim',
  'group',
  'compact',
  'csv',
  'sql',
] as const;

/** True if `name` is a known interpolation filter. */
export function isFilterName(name: string): boolean {
  return (FILTER_NAMES as readonly string[]).includes(name);
}

/**
 * Apply one interpolation filter `kind` (with its raw `arg`) to `value`. Unknown
 * filters are a no-op (the validator flags the typo). Arg formats: `mask:PATTERN`,
 * `slice:from[,to]`, `replace:from,to`, `trim`, `group:size[,sep]` (sep default
 * space), and the four case transforms (no arg).
 */
export function applyFilter(kind: string, arg: string | undefined, value: string): string {
  switch (kind) {
    case 'mask':
      return applyMask(arg ?? '', value);
    case 'slice': {
      const [a, b] = (arg ?? '').split(',');
      return applySlice(
        value,
        Number(a ?? '0'),
        b === undefined || b === '' ? undefined : Number(b),
      );
    }
    case 'replace': {
      const [a, b] = splitFirst(arg ?? '', ',');
      return applyReplace(value, a, b ?? '');
    }
    case 'trim':
      return applyTrim(value);
    case 'group': {
      const [a, b] = splitFirst(arg ?? '', ',');
      return applyGroup(value, Number(a || '3'), b ?? ' ');
    }
    case 'compact':
      return applyCompact(value, arg === undefined || arg === '' ? 36 : Number(arg));
    case 'csv':
      return applyCsv(value, arg === undefined || arg === '' ? ',' : arg);
    case 'sql':
      return applySql(value);
    case 'upper':
    case 'lower':
    case 'capitalize':
    case 'title':
      return applyCase(kind, value);
    default:
      return value;
  }
}

/** One parsed element of a mask pattern. */
type MaskSlot =
  | { readonly kind: 'char' } // bare x
  | { readonly kind: 'word' } // bare w
  | { readonly kind: 'charAt'; readonly from: number; readonly to: number } // x[i] / x[a..b]
  | { readonly kind: 'wordAt'; readonly from: number; readonly to: number } // w[i] / w[a..b]
  | { readonly kind: 'rest' } // *
  | { readonly kind: 'lit'; readonly text: string };

/** `-3`, `7`, `0..4`, `-2..-1` — nothing else. Returns null if it is not one. */
function parseIndexSpec(body: string): { from: number; to: number } | null {
  const one = /^(-?\d+)$/.exec(body);
  if (one) {
    const n = Number(one[1]);
    return { from: n, to: n };
  }
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
  if (!range) return null;
  return { from: Number(range[1]), to: Number(range[2]) };
}

/**
 * Split a mask into slots. A `[` is index syntax ONLY directly after `x`/`w`;
 * anywhere else it is an ordinary literal, so `mask="[tel.] xxx"` needs no
 * escaping. A backslash still escapes the next character.
 */
function parseMask(pattern: string): MaskSlot[] {
  const pat = Array.from(pattern);
  const slots: MaskSlot[] = [];
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i] ?? '';
    if (ch === '\\' && i + 1 < pat.length) {
      slots.push({ kind: 'lit', text: pat[i + 1] ?? '' });
      i += 1;
      continue;
    }
    if (ch === '*') {
      slots.push({ kind: 'rest' });
      continue;
    }
    if (ch !== 'x' && ch !== 'w') {
      slots.push({ kind: 'lit', text: ch });
      continue;
    }
    // x or w — is it indexed?
    if (pat[i + 1] === '[') {
      const close = pat.indexOf(']', i + 2);
      if (close !== -1) {
        const body = pat.slice(i + 2, close).join('');
        const spec = parseIndexSpec(body);
        if (spec === null) {
          throw new Error(
            `mask: invalid index "[${body}]" after "${ch}" — use ${ch}[0], ` +
              `${ch}[0..4] or ${ch}[-1]; ranges use ".." (a hyphen would clash ` +
              `with a negative index). For a literal bracket write ${ch}\\[`,
          );
        }
        slots.push({ kind: ch === 'x' ? 'charAt' : 'wordAt', from: spec.from, to: spec.to });
        i = close;
        continue;
      }
      // No closing bracket at all: plainly literal text, leave it alone.
    }
    slots.push({ kind: ch === 'x' ? 'char' : 'word' });
  }
  return slots;
}

/** Spans of the non-whitespace runs of `chars`, in order. */
function wordSpans(chars: readonly string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let i = 0;
  while (i < chars.length) {
    if (/\s/u.test(chars[i] ?? '')) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < chars.length && !/\s/u.test(chars[i] ?? '')) i += 1;
    spans.push({ start, end: i });
  }
  return spans;
}

/**
 * Apply a positional mask (spec docs/specs/2026-07-23-mask-positional-reordering.md).
 *
 * `x` — one character, `w` — one word (+ swallow one whitespace), `*` — everything
 * not yet consumed; a backslash escapes the next character; every other character
 * is a literal.
 *
 * `x[i]` / `w[i]` address the ORIGINAL input, 0-based, negative from the end,
 * `a..b` inclusive. Two channels that do not interfere: what an index EMITS never
 * depends on consumption, and consumption only decides what the bare `x`/`w`/`*`
 * have left. So the same notation reads as a move when nothing else picks that
 * position up, and as a copy when something does.
 *
 * Lenient by design: an out-of-range index emits nothing, silently — the input
 * length is unknown until render time, so there is nothing to validate against,
 * and aborting a million-row run over one short value is worse than a gap.
 */
export function applyMask(pattern: string, input: string): string {
  const chars = Array.from(input);
  const used = new Array<boolean>(chars.length).fill(false);
  const isSpace = (i: number): boolean => /\s/u.test(chars[i] ?? '');
  const nextFree = (): number => {
    let i = 0;
    while (i < chars.length && used[i] === true) i += 1;
    return i;
  };
  /** Resolve a possibly-negative index against a length; -1 is the last item. */
  const resolve = (n: number, len: number): number => (n < 0 ? len + n : n);
  /** Indices from..to inclusive, descending when the range runs backwards. */
  const walk = (from: number, to: number, len: number): number[] => {
    const a = resolve(from, len);
    const b = resolve(to, len);
    const step = a <= b ? 1 : -1;
    const out: number[] = [];
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      if (i >= 0 && i < len) out.push(i);
    }
    return out;
  };

  const spans = wordSpans(chars);
  let out = '';

  for (const slot of parseMask(pattern)) {
    switch (slot.kind) {
      case 'lit':
        out += slot.text;
        break;

      case 'char': {
        const i = nextFree();
        if (i < chars.length) {
          out += chars[i] ?? '';
          used[i] = true;
        }
        break;
      }

      case 'word': {
        let i = nextFree();
        while (i < chars.length && used[i] !== true && !isSpace(i)) {
          out += chars[i] ?? '';
          used[i] = true;
          i += 1;
        }
        if (i < chars.length && used[i] !== true && isSpace(i)) used[i] = true; // one delimiter
        break;
      }

      case 'charAt':
        for (const i of walk(slot.from, slot.to, chars.length)) {
          out += chars[i] ?? '';
          used[i] = true;
        }
        break;

      case 'wordAt': {
        const picked = walk(slot.from, slot.to, spans.length);
        out += picked
          .map((wi) => {
            const span = spans[wi];
            if (span === undefined) return '';
            for (let i = span.start; i < span.end; i++) used[i] = true;
            // Take one adjacent delimiter with it, so the leftovers a later `*`
            // prints don't collapse into a double space.
            if (span.end < chars.length && isSpace(span.end)) used[span.end] = true;
            else if (span.start > 0 && isSpace(span.start - 1)) used[span.start - 1] = true;
            return chars.slice(span.start, span.end).join('');
          })
          .join(' ');
        break;
      }

      case 'rest':
        for (let i = 0; i < chars.length; i++) {
          if (used[i] !== true) {
            out += chars[i] ?? '';
            used[i] = true;
          }
        }
        break;
    }
  }
  return out;
}

/**
 * Render a whole number in a shorter alphabet — `1000000` becomes `lfls`.
 *
 * The point is a unique suffix that stays readable at scale: a row id appended
 * to a generated email keeps it unique, but `john.smith2000000000@` is nobody's
 * address. In base 36 the same id is `x2qxvk`, and six characters carry over
 * two billion rows.
 *
 * LOWERCASE only, and deliberately so. Base 62 would be shorter still, but many
 * systems fold the local part of an address to lower case — `aB` and `Ab` would
 * merge and silently reintroduce exactly the duplicates the suffix exists to
 * prevent.
 *
 * A value that is not a whole number passes through untouched. Filters here are
 * lenient by design; the validator is where a mistake gets named.
 */
export function applyCompact(value: string, base: number): string {
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) return value;
  if (!Number.isInteger(base) || base < 2 || base > 36) return value;
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return value;
  return (n < 0 ? '-' : '') + Math.abs(n).toString(base);
}

/**
 * Quote a value for CSV per RFC 4180: wrap in quotes and double any inside.
 *
 * `<data>` assembles TEXT and knows nothing about the file being written, so a
 * value carrying the delimiter silently splits the row. Measured on a real
 * catalogue: one product named `Набор ножей, 3 шт` turned 6172 of 50 000 rows
 * into eight fields where the header declares seven — category landing in
 * price, price in quantity — with no error and nothing visibly wrong.
 *
 * Quoting unconditionally rather than only when needed: a rule with no
 * exceptions is one nobody has to remember, every CSV reader accepts redundant
 * quotes, and "only when it contains a comma" is exactly the reasoning that
 * loses to a newline or a quote later.
 *
 * `arg` names the delimiter for a non-comma file (`csv:;`) — it does not change
 * the output today, but it documents intent at the call site and keeps the door
 * open for a smarter rule.
 */
export function applyCsv(value: string, _delimiter: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Escape a value for a single-quoted SQL literal by doubling apostrophes.
 *
 * `O'Brien` closes the string early and the statement fails to parse — or, far
 * worse in generated data, parses into something else. Emits the BODY only, no
 * surrounding quotes, so the caller keeps writing `'${{Name|sql}}'` and the
 * shape of the statement stays visible in the config.
 */
export function applySql(value: string): string {
  return value.replace(/'/g, "''");
}
