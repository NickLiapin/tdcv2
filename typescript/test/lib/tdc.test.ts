import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TdcDiagnosticError } from '../../src/errors/index.js';
import { TDC } from '../../src/lib/tdc.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();
const TINY = `<tdc><env count="3" seed="t" inject="\${{%}}"></env><block><line><data>row \${{_count}}</data></line></block></tdc>`;

describe('TDC class', () => {
  it('constructs from configString', () => {
    const tdc = new TDC({ configString: TINY, now: FIXED_NOW });
    expect(tdc.toString()).toBe('row 1\nrow 2\nrow 3\n');
  });

  it('constructs from configFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-class-'));
    const file = join(dir, 'config.xml');
    writeFileSync(file, TINY);
    const tdc = new TDC({ configFile: file, now: FIXED_NOW });
    expect(tdc.toString()).toBe('row 1\nrow 2\nrow 3\n');
  });

  it('resolves relative file sources against the configFile directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-class-relative-src-'));
    writeFileSync(join(dir, 'names.txt'), 'Alice\nBob\n');
    const file = join(dir, 'config.tdc');
    writeFileSync(
      file,
      '<tdc><env count="4" seed="file-base"><sequence name="n"><gen type="file" src="names.txt"/></sequence></env><block><line><data>${{n}}</data></line></block></tdc>',
    );

    const lines = new TDC({ configFile: file, now: FIXED_NOW })
      .toString()
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(['Alice', 'Bob']).toContain(line);
  });

  it('resolves @data file sources through configured dataPaths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-class-data-path-'));
    const data = join(dir, 'data');
    mkdirSync(data);
    writeFileSync(join(data, 'names.txt'), 'Alice\nBob\n');
    const dsl =
      '<tdc><env count="4" seed="data-path"><sequence name="n"><gen type="file" src="@data/names.txt"/></sequence></env><block><line><data>${{n}}</data></line></block></tdc>';

    const lines = new TDC({ configString: dsl, dataPaths: [data], now: FIXED_NOW })
      .toString()
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect(['Alice', 'Bob']).toContain(line);
  });

  it('rejects both configFile and configString together', () => {
    expect(() => new TDC({ configString: TINY, configFile: '/x' })).toThrow(/both/);
  });

  it('rejects neither configFile nor configString', () => {
    expect(() => new TDC({})).toThrow(/must be provided/);
  });

  it('writeFile writes the rendered output to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-write-'));
    const out = join(dir, 'out.txt');
    const tdc = new TDC({ configString: TINY, now: FIXED_NOW });
    tdc.writeFile(out);
    expect(readFileSync(out, 'utf8')).toBe('row 1\nrow 2\nrow 3\n');
  });

  it('toIterator yields each row as a separate string', () => {
    const tdc = new TDC({ configString: TINY, now: FIXED_NOW });
    const rows = [...tdc.toIterator()];
    expect(rows).toEqual(['row 1\n', 'row 2\n', 'row 3\n']);
  });

  it('toStream yields the same text as toString', async () => {
    const tdc = new TDC({ configString: TINY, now: FIXED_NOW });
    await expect(collectStream(tdc.toStream())).resolves.toBe(tdc.toString());
  });

  it('is reusable — multiple terminal calls all produce identical output', () => {
    const tdc = new TDC({ configString: TINY, seed: 'fixed', now: FIXED_NOW });
    const a = tdc.toString();
    const b = tdc.toString();
    expect(a).toBe(b);
  });

  it('toArray exposes sequence data as object rows', () => {
    const DSL = [
      '<tdc>',
      '  <env count="6" seed="objects">',
      '    <sequence name="Gender"><gen type="text" value="Male,Female" percent="50,50"/></sequence>',
      '    <sequence name="MaleFlag" parent="Gender.Male"><gen type="text" value="yes"/></sequence>',
      '    <sequence name="Person">',
      '      <gen name="FirstName" type="template" value="person.male.firstName"/>',
      '      <gen name="Code" type="number" value="0000..9999"/>',
      '    </sequence>',
      '  </env>',
      '  <block><line><data>${{Gender}},${{Person.FirstName}}</data></line></block>',
      '</tdc>',
    ].join('\n');
    const rows = new TDC({ configString: DSL, now: FIXED_NOW }).toArray();
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row['Gender'] === 'Male')).toHaveLength(3);
    expect(rows.filter((row) => row['Gender'] === 'Female')).toHaveLength(3);

    for (const row of rows) {
      expect(row['Person']).toEqual({
        FirstName: expect.any(String),
        Code: expect.stringMatching(/^\d{4}$/),
      });
      if (row['Gender'] === 'Male') expect(row['MaleFlag']).toBe('yes');
      else expect(row['MaleFlag']).toBeUndefined();
    }
  });

  it('iterate and getAt expose the same object rows as toArray', () => {
    const DSL = `<tdc><env count="4" seed="object-api"><sequence name="N"><gen type="increment" value="10" step="2"/></sequence></env><block><line><data>\${{N}}</data></line></block></tdc>`;
    const tdc = new TDC({ configString: DSL, now: FIXED_NOW });
    const rows = tdc.toArray();
    expect([...tdc.iterate()]).toEqual(rows);
    expect(tdc.getAt(2)).toEqual(rows[2]);
    expect(() => tdc.getAt(4)).toThrow(/out of range/);
  });

  it('seed override changes output from the declared one', () => {
    // count=20 (not 3): with only 3 values, a 3-row output has too few distinct
    // permutations, so two arbitrary seeds can collide by chance on the default
    // engine. Twenty rows give ample entropy to detect the seed change reliably.
    const DSL = `<tdc><env count="20" seed="default" inject="\${{%}}"><sequence name="X"><gen type="text" value="a,b,c"/></sequence></env><block><line><data>\${{X}}</data></line></block></tdc>`;
    const a = new TDC({ configString: DSL, now: FIXED_NOW }).toString();
    const b = new TDC({ configString: DSL, seed: 'alternate', now: FIXED_NOW }).toString();
    expect(a).not.toBe(b);
  });

  it('count override produces a different number of rows', () => {
    const DSL = `<tdc><env count="10" seed="s" inject="\${{%}}"></env><block><line><data>x</data></line></block></tdc>`;
    const a = new TDC({ configString: DSL }).toString();
    const b = new TDC({ configString: DSL, count: 3 }).toString();
    expect(a.split('\n').filter(Boolean)).toHaveLength(10);
    expect(b.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('the object API and the text output agree, value for value', () => {
    // They used to be two different engines with two different ideas of
    // randomness, so one object answered differently depending on the method
    // called. The engines agree now, so this is a real check rather than a
    // restatement of one code path.
    const DSL = `<tdc><env count="12" seed="obj-agree" local="en" inject="\${{%}}">
        <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
        <sequence name="N"><gen type="number" value="10..99"/></sequence>
        <sequence name="L"><gen type="template" value="person.lastName"/></sequence>
      </env><block><line><data>\${{G}},\${{N}},\${{L}}</data></line></block></tdc>`;
    const tdc = new TDC({ configString: DSL });
    // Every column here is a simple sequence, so each cell is a scalar; the
    // nested shape belongs to compounds and pools (see the next test).
    const cell = (r: Record<string, unknown>, name: string): string =>
      typeof r[name] === 'string' ? r[name] : '';
    const rows = [...tdc.iterate()].map((r) => `${cell(r, 'G')},${cell(r, 'N')},${cell(r, 'L')}`);
    expect(rows).toEqual(tdc.toString().split('\n').filter(Boolean));
    expect(tdc.getAt(4)).toEqual([...tdc.iterate()][4]);
  });

  it('a pool reference reaches the object API as a member with fields', () => {
    // A `<gen type="pool">` registers one column per pool field under
    // `Name.field` and nothing under `Name` — read it the way a simple
    // sequence is read and the whole thing comes back undefined, which is
    // exactly what it used to do.
    const DSL = `<tdc><env count="6" seed="obj-pool" local="en" inject="\${{%}}">
        <pool name="Doc" count="3">
          <sequence name="last"><gen type="text" value="Smith,Jones,Brown"/></sequence>
          <sequence name="room"><gen type="number" value="100..199"/></sequence>
        </pool>
        <sequence name="D"><gen type="pool" value="Doc"/></sequence>
      </env><block><line><data>\${{D.last}}/\${{D.room}}</data></line></block></tdc>`;
    const tdc = new TDC({ configString: DSL });
    const rows = [...tdc.iterate()].map((r) => {
      const d = r['D'] as Record<string, string>;
      return `${d['last'] ?? ''}/${d['room'] ?? ''}`;
    });
    expect(rows).toEqual(tdc.toString().split('\n').filter(Boolean));
  });

  describe('validation', () => {
    it('collects ALL semantic errors before rendering, not just the first', () => {
      const BAD = [
        '<tdc>',
        '  <env inject="no_placeholder">',
        '    <sequence name="X"><gen type="txt" value="a,b"/></sequence>',
        '    <sequence name="Y"><gen type="template" value="person.bad.path"/></sequence>',
        '  </env>',
        '  <block><line><data>x</data></line></block>',
        '</tdc>',
      ].join('\n');
      let caught: TdcDiagnosticError | undefined;
      try {
        new TDC({ configString: BAD });
      } catch (e) {
        if (e instanceof TdcDiagnosticError) caught = e;
      }
      expect(caught).toBeDefined();
      // All three errors present in a single throw — this is the whole
      // point of a dedicated validation pass.
      const codes = caught?.diagnostics.map((d) => d.code ?? '');
      expect(codes).toContain('TDC021'); // inject pattern
      expect(codes).toContain('TDC041'); // unknown gen type
      expect(codes).toContain('TDC071'); // unknown template path
    });

    it('exposes non-fatal warnings on the `diagnostics` property', () => {
      // A single malformed <map> row is the one case the validator recovers
      // from rather than aborting: it skips that row, keeps the valid ones,
      // and reports TDC136 as a warning. Structural mistakes (a stray child,
      // a reserved name, a typed <data> with no name) are errors and throw.
      const DSL_WITH_WARN = [
        '<tdc>',
        '  <env count="2" seed="s">',
        '    <sequence name="G"><gen type="text" value="a,b"/></sequence>',
        '    <switch name="W" on="G"><map>a:1, bogusrow</map></switch>',
        '  </env>',
        '  <block><line><data>${{W}}</data></line></block>',
        '</tdc>',
      ].join('\n');
      const tdc = new TDC({ configString: DSL_WITH_WARN });
      expect(tdc.diagnostics.length).toBeGreaterThan(0);
      expect(tdc.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
    });

    it('successful construction exposes an empty diagnostic list', () => {
      const tdc = new TDC({ configString: TINY });
      expect(tdc.diagnostics).toEqual([]);
    });

    it('carries the original source on TdcDiagnosticError for formatter use', () => {
      const BAD = '<tdc></tdc>'; // no <block>
      let caught: TdcDiagnosticError | undefined;
      try {
        new TDC({ configString: BAD });
      } catch (e) {
        if (e instanceof TdcDiagnosticError) caught = e;
      }
      expect(caught?.source).toBe(BAD);
    });

    it('refuses to process documents that require a newer TDC runtime', () => {
      const FUTURE = '<tdc version="999.0"><block><line><data>x</data></line></block></tdc>';
      let caught: TdcDiagnosticError | undefined;
      try {
        new TDC({ configString: FUTURE });
      } catch (e) {
        if (e instanceof TdcDiagnosticError) caught = e;
      }
      expect(caught?.diagnostics.some((d) => d.code === 'TDC005')).toBe(true);
    });
  });
});

async function collectStream(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return out;
}
