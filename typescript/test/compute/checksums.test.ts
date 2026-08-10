import { describe, expect, it } from 'vitest';

import { luhnCheckDigit, weightedSum } from '../../src/presets/utils.js';

import { evalCompute } from './helpers.js';

/**
 * The three worked check-digit algorithms from spec §9, expressed as compute
 * trees, cross-checked against the reference implementations in the codebase
 * over many random inputs. If the declarative `compute` layer is correct, these
 * must agree for every input.
 */

// --- the algorithms as compute data (spec §9, snake_case tag names) ---

const INN_CHECK = `<compute name="check">
  <let name="sum">
    <reduce>
      <over><field name="base"/></over>
      <init><int v="0"/></init>
      <do>
        <add>
          <acc/>
          <multiply>
            <current/>
            <at><in><list v="2,4,10,3,5,9,4,6,8"/></in>
                <index><current_index/></index></at>
          </multiply>
        </add>
      </do>
    </reduce>
  </let>
  <result><mod><mod><use name="sum"/><int v="11"/></mod><int v="10"/></mod></result>
</compute>`;

const IBAN_CHECK = `<compute name="check">
  <let name="normalized">
    <concat><field name="bban"/><field name="country"/><str v="00"/></concat>
  </let>
  <let name="digits">
    <join>
      <each>
        <over><use name="normalized"/></over>
        <do><encode as="base36"><current/></encode></do>
      </each>
    </join>
  </let>
  <let name="rem">
    <reduce>
      <over><use name="digits"/></over>
      <init><int v="0"/></init>
      <do>
        <mod>
          <add><multiply><acc/><int v="10"/></multiply><current/></add>
          <int v="97"/>
        </mod>
      </do>
    </reduce>
  </let>
  <result><pad width="2"><subtract><int v="98"/><use name="rem"/></subtract></pad></result>
</compute>`;

const LUHN_CHECK = `<compute name="check">
  <let name="sum">
    <reduce>
      <over><field name="base"/></over>
      <init><int v="0"/></init>
      <do>
        <add>
          <acc/>
          <choose>
            <when>
              <test><equals>
                <mod><current_index/><int v="2"/></mod>
                <mod><add><length><field name="base"/></length><int v="1"/></add><int v="2"/></mod>
              </equals></test>
              <then>
                <let name="d"><multiply><current/><int v="2"/></multiply></let>
                <choose>
                  <when><test><greater_than><use name="d"/><int v="9"/></greater_than></test>
                        <then><subtract><use name="d"/><int v="9"/></subtract></then></when>
                  <otherwise><use name="d"/></otherwise>
                </choose>
              </then>
            </when>
            <otherwise><current/></otherwise>
          </choose>
        </add>
      </do>
    </reduce>
  </let>
  <result><mod><subtract><int v="10"/><mod><use name="sum"/><int v="10"/></mod></subtract><int v="10"/></mod></result>
</compute>`;

// --- oracles ---

function innCheck(base: string): string {
  return String((weightedSum(base, [2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11) % 10);
}

function ibanCheck(bban: string, country: string): string {
  const normalized = `${bban}${country}00`;
  let digits = '';
  for (const ch of normalized) {
    digits += /[0-9]/.test(ch) ? ch : String(ch.toUpperCase().charCodeAt(0) - 55);
  }
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return String(98 - rem).padStart(2, '0');
}

// --- deterministic pseudo-random input generation ---

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function digits(rng: () => number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += String(Math.floor(rng() * 10));
  return out;
}

function letters(rng: () => number, len: number): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < len; i++) out += A[Math.floor(rng() * 26)] ?? 'A';
  return out;
}

describe('INN weighted-sum (spec §9.1)', () => {
  it('matches the spec trace', () => {
    expect(evalCompute(INN_CHECK, { base: '500100732' })).toBe('9');
  });

  it('agrees with weightedSum over 300 random 9-digit bases', () => {
    const rng = lcg(1);
    for (let i = 0; i < 300; i++) {
      const base = digits(rng, 9);
      expect(evalCompute(INN_CHECK, { base })).toBe(innCheck(base));
    }
  });
});

describe('IBAN ISO-7064 mod-97 (spec §9.2)', () => {
  it('matches a known IBAN (DE89 3704 0044 0532 0130 00)', () => {
    expect(evalCompute(IBAN_CHECK, { bban: '370400440532013000', country: 'DE' })).toBe('89');
  });

  it('agrees with the mod-97 oracle over 300 random BBAN/country pairs', () => {
    const rng = lcg(2);
    for (let i = 0; i < 300; i++) {
      const bban = digits(rng, 18);
      const country = letters(rng, 2);
      expect(evalCompute(IBAN_CHECK, { bban, country })).toBe(ibanCheck(bban, country));
    }
  });
});

describe('Luhn (spec §9.3)', () => {
  it('matches a known Luhn payload (7992739871 -> 3)', () => {
    expect(evalCompute(LUHN_CHECK, { base: '7992739871' })).toBe('3');
  });

  it('agrees with luhnCheckDigit over 300 random payloads of varied length', () => {
    const rng = lcg(3);
    for (let i = 0; i < 300; i++) {
      const len = 6 + Math.floor(rng() * 18);
      const base = digits(rng, len);
      expect(evalCompute(LUHN_CHECK, { base })).toBe(String(luhnCheckDigit(base)));
    }
  });
});
