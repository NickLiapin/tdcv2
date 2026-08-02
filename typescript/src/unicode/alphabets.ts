/**
 * Named Unicode alphabets shared by character-oriented generators.
 *
 * Keep this registry intentionally explicit. It is easier to port to
 * Python/Java than relying on runtime-specific Unicode property engines,
 * and it gives the DSL stable names that can be documented and tested.
 */

export interface AlphabetDefinition {
  readonly name: string;
  readonly description: string;
  readonly chars: readonly string[];
}

const ASCII_DIGITS = charsBetween('0', '9');
const LATIN_LOWER = charsBetween('a', 'z');
const LATIN_UPPER = charsBetween('A', 'Z');

const CYRILLIC_RU_LOWER = [...charsBetween('а', 'е'), 'ё', ...charsBetween('ж', 'я')] as const;
const CYRILLIC_RU_UPPER = [...charsBetween('А', 'Е'), 'Ё', ...charsBetween('Ж', 'Я')] as const;

const DEFINITIONS: readonly AlphabetDefinition[] = [
  {
    name: 'latin.lower',
    description: 'ASCII lowercase Latin letters a-z',
    chars: LATIN_LOWER,
  },
  {
    name: 'latin.upper',
    description: 'ASCII uppercase Latin letters A-Z',
    chars: LATIN_UPPER,
  },
  {
    name: 'latin.letters',
    description: 'ASCII Latin letters A-Z and a-z',
    chars: [...LATIN_UPPER, ...LATIN_LOWER],
  },
  {
    name: 'digits.ascii',
    description: 'ASCII digits 0-9',
    chars: ASCII_DIGITS,
  },
  {
    name: 'digits.fullwidth',
    description: 'Fullwidth digits ０-９',
    chars: charsBetween('０', '９'),
  },
  {
    name: 'cyrillic.ru.lower',
    description: 'Russian lowercase Cyrillic letters, including ё',
    chars: CYRILLIC_RU_LOWER,
  },
  {
    name: 'cyrillic.ru.upper',
    description: 'Russian uppercase Cyrillic letters, including Ё',
    chars: CYRILLIC_RU_UPPER,
  },
  {
    name: 'cyrillic.ru.letters',
    description: 'Russian Cyrillic letters, including Ё/ё',
    chars: [...CYRILLIC_RU_UPPER, ...CYRILLIC_RU_LOWER],
  },
  {
    name: 'greek.letters',
    description: 'Basic Greek letters Α-Ω and α-ω',
    chars: Array.from('ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω'),
  },
  {
    name: 'hebrew.letters',
    description: 'Hebrew letters א-ת',
    chars: charsBetween('א', 'ת'),
  },
  {
    name: 'arabic.letters',
    description: 'Arabic letters ء-ي',
    chars: charsBetween('ء', 'ي'),
  },
  {
    name: 'kana.hiragana',
    description: 'Japanese Hiragana characters ぁ-ゖ',
    chars: charsBetween('ぁ', 'ゖ'),
  },
  {
    name: 'kana.katakana',
    description: 'Japanese Katakana characters ァ-ヺ',
    chars: charsBetween('ァ', 'ヺ'),
  },
  {
    name: 'cjk.unified.basic',
    description: 'CJK Unified Ideographs U+4E00..U+9FFF',
    chars: charsBetween('\u4E00', '\u9FFF'),
  },
  {
    name: 'roman.upper',
    description: 'Roman numeral letters I, V, X, L, C, D, M',
    chars: Array.from('IVXLCDM'),
  },
  {
    name: 'roman.lower',
    description: 'Roman numeral letters i, v, x, l, c, d, m',
    chars: Array.from('ivxlcdm'),
  },
] as const;

const REGISTRY = new Map<string, AlphabetDefinition>(
  DEFINITIONS.map((definition) => [definition.name, definition]),
);

export const ALPHABET_DEFINITIONS: readonly AlphabetDefinition[] = DEFINITIONS;
export const ALPHABET_NAMES: readonly string[] = DEFINITIONS.map((definition) => definition.name);

export function resolveAlphabet(name: string): AlphabetDefinition | undefined {
  return REGISTRY.get(name);
}

export function resolveAlphabetChars(name: string): readonly string[] | undefined {
  return resolveAlphabet(name)?.chars;
}

export function charsBetween(start: string, end: string): string[] {
  const a = start.codePointAt(0);
  const b = end.codePointAt(0);
  if (a === undefined || b === undefined || a > b) {
    throw new Error(`invalid alphabet range "${start}-${end}"`);
  }
  const out: string[] = [];
  for (let code = a; code <= b; code++) out.push(String.fromCodePoint(code));
  return out;
}

export function toCodePoints(value: string): string[] {
  return Array.from(value);
}
