/**
 * Three promises the typed-output page makes, and how each was broken.
 *
 * All three were measured against the unfixed engine first; the numbers and
 * strings below are what it produced.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';
import { convertValue } from '../../src/output/parquet/convert.js';
import { parse } from '../../src/parser/parse.js';
import { validate } from '../../src/validator/validate.js';

const dir = mkdtempSync(join(tmpdir(), 'tdc-parquet-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a timestamp means the same instant on every machine', () => {
  it('reads a zoneless ISO datetime as UTC', () => {
    // Was Date.parse, which ECMAScript says is LOCAL for a zoneless datetime —
    // while the column is written isAdjustedToUTC=true. TZ=Asia/Tokyo moved the
    // value to the previous DAY, and produced a different file byte for byte.
    const utcMidnight = Date.UTC(2020, 5, 5, 0, 0, 0);
    expect(convertValue('2020-06-05T00:00:00', { kind: 'timestamp', nullable: false })).toBe(
      BigInt(utcMidnight),
    );
    expect(convertValue('2020-06-05', { kind: 'timestamp', nullable: false })).toBe(
      BigInt(utcMidnight),
    );
  });

  it('still honours an explicit zone', () => {
    const noon = Date.UTC(2020, 5, 5, 12, 0, 0);
    expect(convertValue('2020-06-05T12:00:00Z', { kind: 'timestamp', nullable: false })).toBe(
      BigInt(noon),
    );
    expect(convertValue('2020-06-05T21:00:00+09:00', { kind: 'timestamp', nullable: false })).toBe(
      BigInt(noon),
    );
    expect(convertValue('2020-06-05T07:00:00-05:00', { kind: 'timestamp', nullable: false })).toBe(
      BigInt(noon),
    );
  });

  it('refuses what Date.parse would have guessed at', () => {
    // "May 25, 1996" parses in V8 and means different instants on different
    // hosts. Nobody writes it here on purpose.
    expect(() => convertValue('May 25, 1996', { kind: 'timestamp', nullable: false })).toThrow(
      /ISO-8601/,
    );
  });
});

describe('a .parquet appears only when it is complete', () => {
  it('leaves nothing behind when the run stops partway', () => {
    // Before: 200013 bytes with no footer — "Parquet magic bytes not found".
    const out = join(dir, 'partial.parquet');
    const tdc = new TDC({
      configString:
        '<tdc><env count="70000" seed="p">' +
        '<sequence name="Id"><gen type="increment" value="1"/></sequence></env>' +
        '<block><line><data name="n" type="uint16">${{Id}}</data></line></block></tdc>',
    });
    expect(() => {
      tdc.writeFile(out);
    }).toThrow(/out of range for uint16/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('writes the file when the run succeeds', () => {
    const out = join(dir, 'ok.parquet');
    new TDC({
      configString:
        '<tdc><env count="4" seed="p">' +
        '<sequence name="Id"><gen type="increment" value="1"/></sequence></env>' +
        '<block><line><data name="n" type="int64">${{Id}}</data></line></block></tdc>',
    }).writeFile(out);
    expect(readFileSync(out).subarray(0, 4).toString('latin1')).toBe('PAR1');
  });
});

describe('a typed column cannot be conditional', () => {
  function codes(config: string): string[] {
    const parsed = parse(config);
    expect(parsed.diagnostics).toEqual([]);
    return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
  }

  const head =
    '<tdc><env count="4" seed="c">' +
    '<sequence name="Id"><gen type="increment" value="1"/></sequence></env><block>';

  it('refuses if= on a named <data>', () => {
    // Before: tail=['END','END','END','END'] beside a text run showing it once.
    expect(
      codes(
        `${head}<line><data name="id">\${{Id}}</data>` +
          '<data name="tail" if="_last">END</data></line></block></tdc>',
      ),
    ).toContain('TDC209');
  });

  it('refuses a <line if="…"> that holds one', () => {
    expect(
      codes(`${head}<line if="_first"><data name="only_first">X</data></line></block></tdc>`),
    ).toContain('TDC209');
  });

  it('leaves an UNNAMED conditional alone — text output has no columns', () => {
    expect(
      codes(
        `${head}<line><data>\${{Id}}</data><data if="_last">END</data></line>` +
          '<line if="_first"><data>X</data></line></block></tdc>',
      ),
    ).toEqual([]);
  });
});
