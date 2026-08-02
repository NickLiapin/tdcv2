import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseGeneratorSpec, scanPacks } from '../../src/data-pack/index.js';
import { TDC } from '../../src/lib/tdc.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('parseGeneratorSpec — single primitive', () => {
  it('parses a single primitive <gen> into a spec', () => {
    const r = parseGeneratorSpec('<gen type="regex" value="[a-z]{3}"/>');
    expect(r.generator?.body).toEqual({
      kind: 'single',
      gen: { type: 'regex', attrs: { type: 'regex', value: '[a-z]{3}' } },
    });
    expect(r.generator?.references).toEqual([]);
  });

  it('rejects a bare template gen (use sequences + data to reference)', () => {
    const r = parseGeneratorSpec('<gen type="template" value="ru.person.male.firstName"/>');
    expect(r.generator).toBeUndefined();
    expect(r.error).toMatch(/not supported/);
  });

  it('rejects a <gen> without a type', () => {
    expect(parseGeneratorSpec('<gen value="x"/>').error).toMatch(/type/);
  });
});

describe('parseGeneratorSpec — composed', () => {
  it('parses a compound local sequence + <data> output and collects references', () => {
    const body = [
      '<sequence name="p">',
      '  <gen name="f" type="template" value="es.person.male.firstName"/>',
      '  <gen name="l" type="template" value="es.person.lastName"/>',
      '</sequence>',
      '<data>${{p.f}} ${{p.l}}</data>',
    ].join('\n');
    const r = parseGeneratorSpec(body);
    expect(r.generator?.body.kind).toBe('composed');
    expect(r.generator?.references).toEqual(['es.person.male.firstName', 'es.person.lastName']);
  });

  it('requires a <data> output when sequences are present', () => {
    const r = parseGeneratorSpec('<sequence name="X"><gen type="number" value="1..9"/></sequence>');
    expect(r.error).toMatch(/output/);
  });

  it('collects references from inside <mix>/<case> gens', () => {
    const body = [
      '<mix name="s" percent="60,40">',
      '  <case>',
      '    <gen type="template" value="es.person.lastName"/>',
      '    <data> </data>',
      '    <gen type="template" value="es.person.lastName"/>',
      '  </case>',
      '  <case>',
      '    <gen type="template" value="es.person.lastName"/>',
      '  </case>',
      '</mix>',
      '<data>${{s}}</data>',
    ].join('\n');
    const r = parseGeneratorSpec(body);
    expect(r.generator?.body.kind).toBe('composed');
    expect(r.generator?.references).toEqual([
      'es.person.lastName',
      'es.person.lastName',
      'es.person.lastName',
    ]);
  });

  it('rejects a disallowed gen type hidden inside a mix case', () => {
    const body = [
      '<mix name="s">',
      '  <case><gen type="file" src="/etc/passwd"/></case>',
      '</mix>',
      '<data>${{s}}</data>',
    ].join('\n');
    const r = parseGeneratorSpec(body);
    expect(r.generator).toBeUndefined();
    expect(r.error).toMatch(/file/);
  });

  it('collects <distinct> groups from a composed body', () => {
    const body = [
      '<sequence name="p">',
      '  <distinct>',
      '    <gen name="f1" type="template" value="es.person.male.firstName"/>',
      '    <gen name="f2" type="template" value="es.person.male.firstName"/>',
      '  </distinct>',
      '</sequence>',
      '<data>${{p.f1}} ${{p.f2}}</data>',
    ].join('\n');
    const r = parseGeneratorSpec(body);
    expect(r.generator?.body.kind).toBe('composed');
    const seq = r.generator?.body.kind === 'composed' ? r.generator.body.sequences[0] : undefined;
    expect(seq?.distinctGroups).toEqual([['f1', 'f2']]);
    // Both fields are still collected as compound fields (references intact).
    expect(r.generator?.references).toEqual([
      'es.person.male.firstName',
      'es.person.male.firstName',
    ]);
  });
});

describe('parseGeneratorSpec — inject (interpolation delimiter)', () => {
  const composed =
    '<sequence name="s"><gen name="v" type="text" value="A"/></sequence><data>${{s.v}}</data>';

  it('records a custom inject on the composed body', () => {
    const r = parseGeneratorSpec(composed, '<<%>>');
    expect(r.generator?.body).toMatchObject({ kind: 'composed', inject: '<<%>>' });
  });

  it('defaults inject to ${{%}} when none is given', () => {
    const body = parseGeneratorSpec(composed).generator?.body;
    expect(body?.kind === 'composed' ? body.inject : undefined).toBe('${{%}}');
  });

  it('rejects an inject pattern with no % placeholder', () => {
    const r = parseGeneratorSpec(composed, '[[nope]]');
    expect(r.generator).toBeUndefined();
    expect(r.error).toMatch(/%/);
  });
});

describe('data-pack generators — custom inject end-to-end', () => {
  it('a generator with its own inject keeps literal ${{...}} in the output', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-inject-e2e-'));
    writeFileSync(
      join(root, 'step.tdc'),
      [
        '---',
        'address: common.ci.step',
        'generator: tdc',
        'inject: <<%>>',
        '---',
        '<sequence name="s"><gen name="tok" type="text" value="A,A"/></sequence>',
        '<data>echo "${{ secrets.TOKEN }}"; pick=<<s.tok>></data>',
      ].join('\n'),
      'utf8',
    );
    const config = [
      '<tdc><env count="1" seed="s" inject="${{%}}">',
      '  <sequence name="P"><gen type="template" value="common.ci.step"/></sequence>',
      '</env><block><line><data>${{P}}</data></line></block></tdc>',
    ].join('\n');
    const out = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW })
      .toString()
      .trim();
    // The GitHub-Actions ${{ }} survived untouched; <<s.tok>> interpolated to A.
    expect(out).toBe('echo "${{ secrets.TOKEN }}"; pick=A');
  });
});

describe('data-pack generators — loading', () => {
  it('registers a generator entry from a generator: header', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-pack-'));
    writeFileSync(
      join(root, 'plate.txt'),
      [
        '---',
        'address: common.demo.plate',
        'generator: tdc',
        '---',
        '<gen type="regex" value="[A-Z][0-9]{2}"/>',
      ].join('\n'),
      'utf8',
    );
    const { registry, diagnostics } = scanPacks([root]);
    expect(diagnostics).toEqual([]);
    const entry = registry.get('common.demo.plate');
    expect(entry?.generator).toEqual({
      kind: 'single',
      gen: { type: 'regex', attrs: { type: 'regex', value: '[A-Z][0-9]{2}' } },
    });
    expect(entry?.values).toBeUndefined();
  });

  it('reports a diagnostic for an invalid generator body', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-bad-'));
    writeFileSync(
      join(root, 'bad.txt'),
      [
        '---',
        'generator: tdc',
        'address: common.bad',
        '---',
        '<gen type="template" value="x"/>',
      ].join('\n'),
      'utf8',
    );
    const { diagnostics } = scanPacks([root]);
    expect(diagnostics.some((d) => d.source === 'pack')).toBe(true);
  });
});

describe('data-pack generators — end to end', () => {
  it('renders a pack generator deterministically in a sequence', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-e2e-'));
    writeFileSync(
      join(root, 'code.txt'),
      [
        '---',
        'address: common.demo.code',
        'generator: tdc',
        '---',
        '<gen type="regex" value="[A-Z]{2}[0-9]{2}"/>',
      ].join('\n'),
      'utf8',
    );
    const config = `<tdc>
      <env count="5" seed="gen-e2e" inject="\${{%}}">
        <sequence name="C"><gen type="template" value="common.demo.code"/></sequence>
      </env>
      <block><line><data>\${{C}}</data></line></block>
    </tdc>`;
    const a = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    const b = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    expect(a).toBe(b);
    for (const v of a.split('\n').filter(Boolean)) expect(v).toMatch(/^[A-Z]{2}[0-9]{2}$/);
  });

  it('runs a pack generator inline in a line', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-inline-'));
    writeFileSync(
      join(root, 'code.txt'),
      [
        '---',
        'address: common.demo.code',
        'generator: tdc',
        '---',
        '<gen type="number" value="10..99"/>',
      ].join('\n'),
      'utf8',
    );
    const config = `<tdc>
      <env count="3" seed="gen-inline" inject="\${{%}}"><sequence name="c"><gen type="template" value="common.demo.code"/></sequence></env>
      <block><line><data>n=\${{c}}</data></line></block>
    </tdc>`;
    const out = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    for (const line of out.split('\n').filter(Boolean)) expect(line).toMatch(/^n=\d{2}$/);
  });

  it('a COMPOSED generator pulls from sibling data lists (deterministic)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-composed-'));
    mkdirSync(join(root, 'common', 'demo'), { recursive: true });
    writeFileSync(join(root, 'common', 'demo', 'name.txt'), 'ann\nbob\ncora\n', 'utf8');
    writeFileSync(
      join(root, 'common', 'demo', 'pair.tdc'),
      [
        '---',
        'address: common.demo.pair',
        'generator: tdc',
        '---',
        '<sequence name="p">',
        '  <gen name="x" type="template" value="common.demo.name"/>',
        '  <gen name="y" type="template" value="common.demo.name"/>',
        '</sequence>',
        '<data>${{p.x}}-${{p.y}}</data>',
      ].join('\n'),
      'utf8',
    );
    const config = `<tdc>
      <env count="6" seed="composed-e2e" inject="\${{%}}">
        <sequence name="P"><gen type="template" value="common.demo.pair"/></sequence>
      </env>
      <block><line><data>\${{P}}</data></line></block>
    </tdc>`;
    const a = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    const b = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    expect(a).toBe(b); // deterministic
    for (const v of a.split('\n').filter(Boolean)) {
      const [x, y] = v.split('-');
      expect(['ann', 'bob', 'cora']).toContain(x);
      expect(['ann', 'bob', 'cora']).toContain(y);
    }
  });

  it('a <mix percent> inside a generator yields an exact distribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-mix-'));
    mkdirSync(join(root, 'common', 'demo'), { recursive: true });
    writeFileSync(join(root, 'common', 'demo', 'word.txt'), 'aa\nbb\ncc\n', 'utf8');
    writeFileSync(
      join(root, 'common', 'demo', 'phrase.tdc'),
      [
        '---',
        'address: common.demo.phrase',
        'generator: tdc',
        '---',
        '<mix name="s" percent="70,30">',
        '  <case><gen type="template" value="common.demo.word"/><data> </data><gen type="template" value="common.demo.word"/></case>',
        '  <case><gen type="template" value="common.demo.word"/></case>',
        '</mix>',
        '<data>${{s}}</data>',
      ].join('\n'),
      'utf8',
    );
    const config = `<tdc>
      <env count="100" seed="mix-pct" inject="\${{%}}">
        <sequence name="P"><gen type="template" value="common.demo.phrase"/></sequence>
      </env>
      <block><line><data>\${{P}}</data></line></block>
    </tdc>`;
    // An exact <mix> distribution is a materialised (Engine 1) behaviour; the
    // seekable streaming default splits the same exact percentages per row.
    // Pin mode="memory" for the exact 70/30 guarantee.
    const out = new TDC({
      configString: config,
      dataPaths: [root],
      now: FIXED_NOW,
      mode: 'memory',
    }).toString();
    const lines = out.split('\n').filter(Boolean);
    const doubles = lines.filter((l) => l.includes(' ')).length;
    expect(doubles).toBe(70); // exact via Hamilton over count, materialised in-generator
  });

  it('allows an acyclic generator-to-generator reference (g1 → g2 → data)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-chain-'));
    mkdirSync(join(root, 'common', 'demo'), { recursive: true });
    writeFileSync(join(root, 'common', 'demo', 'names.txt'), 'a\nb\n', 'utf8');
    // g1 → g2 → common.demo.names (a data leaf). No cycle → allowed and renders.
    writeFileSync(
      join(root, 'common', 'demo', 'g1.tdc'),
      [
        '---',
        'address: common.demo.g1',
        'generator: tdc',
        '---',
        '<sequence name="s"><gen name="v" type="template" value="common.demo.g2"/></sequence>',
        '<data>${{s.v}}!</data>',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(root, 'common', 'demo', 'g2.tdc'),
      [
        '---',
        'address: common.demo.g2',
        'generator: tdc',
        '---',
        '<sequence name="s"><gen name="v" type="template" value="common.demo.names"/></sequence>',
        '<data>${{s.v}}</data>',
      ].join('\n'),
      'utf8',
    );
    const { diagnostics } = scanPacks([root]);
    expect(diagnostics).toEqual([]); // acyclic gen→gen is fine now

    const config = `<tdc>
      <env count="4" seed="gen-chain" inject="\${{%}}">
        <sequence name="P"><gen type="template" value="common.demo.g1"/></sequence>
      </env>
      <block><line><data>\${{P}}</data></line></block>
    </tdc>`;
    const out = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    for (const line of out.split('\n').filter(Boolean)) expect(line).toMatch(/^[ab]!$/);
  });

  it('rejects a direct generator reference cycle (g1 → g2 → g1)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-cycle2-'));
    mkdirSync(join(root, 'common', 'demo'), { recursive: true });
    const pairs: [string, string][] = [
      ['g1', 'common.demo.g2'],
      ['g2', 'common.demo.g1'],
    ];
    for (const [addr, ref] of pairs) {
      writeFileSync(
        join(root, 'common', 'demo', `${addr}.tdc`),
        [
          '---',
          `address: common.demo.${addr}`,
          'generator: tdc',
          '---',
          `<sequence name="s"><gen name="v" type="template" value="${ref}"/></sequence>`,
          '<data>${{s.v}}</data>',
        ].join('\n'),
        'utf8',
      );
    }
    const { diagnostics } = scanPacks([root]);
    expect(diagnostics.some((d) => /cycle/i.test(d.message))).toBe(true);
  });

  it('rejects a self-referential generator (g → g)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-gen-self-'));
    mkdirSync(join(root, 'common', 'demo'), { recursive: true });
    writeFileSync(
      join(root, 'common', 'demo', 'loop.tdc'),
      [
        '---',
        'address: common.demo.loop',
        'generator: tdc',
        '---',
        '<sequence name="s"><gen name="v" type="template" value="common.demo.loop"/></sequence>',
        '<data>${{s.v}}</data>',
      ].join('\n'),
      'utf8',
    );
    const { diagnostics } = scanPacks([root]);
    expect(diagnostics.some((d) => /cycle/i.test(d.message))).toBe(true);
  });
});
