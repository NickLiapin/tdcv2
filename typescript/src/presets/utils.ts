import { randomInt } from '../prng/random.js';
import { toCodePoints } from '../unicode/alphabets.js';

export function randomDigits(prng: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String(randomInt(prng, 0, 10));
  }
  return out;
}

export function randomChars(prng: () => number, alphabet: string, length: number): string {
  const chars = toCodePoints(alphabet);
  if (chars.length === 0) return '';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[randomInt(prng, 0, chars.length)] ?? chars[0] ?? '';
  }
  return out;
}

export function randomNonRepeatedDigits(prng: () => number, length: number): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = randomDigits(prng, length);
    if (!allSame(value)) return value;
  }
  return `1${'0'.repeat(Math.max(0, length - 1))}`;
}

export function luhnCheckDigit(payload: string): number {
  const fullLength = payload.length + 1;
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    let digit = Number(payload[i]);
    if (i % 2 === fullLength % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function weightedSum(source: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    sum += Number(source[i]) * (weights[i] ?? 0);
  }
  return sum;
}

export function groupEvery(value: string, size: number, delimiter: string): string {
  const groups: string[] = [];
  for (let i = 0; i < value.length; i += size) {
    groups.push(value.slice(i, i + size));
  }
  return groups.join(delimiter);
}

export function groupFromRight(value: string, size: number, delimiter: string): string {
  const groups: string[] = [];
  for (let end = value.length; end > 0; end -= size) {
    groups.unshift(value.slice(Math.max(0, end - size), end));
  }
  return groups.join(delimiter);
}

export function allSame(value: string): boolean {
  return value.split('').every((char) => char === value[0]);
}
