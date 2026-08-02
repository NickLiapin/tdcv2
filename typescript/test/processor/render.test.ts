import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('render — defaults & option overrides', () => {
  it('defaults to count=10 when the env has no count attribute', () => {
    // Defaults should produce 10 lines + trailing newline.
    const source =
      '<tdc><env><before></before></env><block><line><data>x</data></line></block></tdc>';
    const out = render(parseStrict(source), { seed: 'any', now: FIXED_NOW });
    expect(out.split('\n').filter((l) => l === 'x')).toHaveLength(10);
  });

  it('option count overrides env count', () => {
    const source = '<tdc><env count="50"></env><block><line><data>y</data></line></block></tdc>';
    const out = render(parseStrict(source), { seed: 's', count: 3, now: FIXED_NOW });
    expect(out.split('\n').filter((l) => l === 'y')).toHaveLength(3);
  });

  it('option seed overrides env seed (deterministic change)', () => {
    const source =
      '<tdc><env count="5" seed="envseed"></env><block><line><gen type="template" value="person.male.firstName"/></line></block></tdc>';
    const a = render(parseStrict(source), { now: FIXED_NOW });
    const b = render(parseStrict(source), { seed: 'otherseed', now: FIXED_NOW });
    expect(a).not.toBe(b);
  });
});

describe('render — errors', () => {
  it('throws if the document has no <tdc> root', () => {
    expect(() => render(parseStrict('<!-- empty -->'))).toThrow(/<tdc>/);
  });

  it('throws if <tdc> has no <block> child', () => {
    expect(() => render(parseStrict('<tdc><env count="1"/></tdc>'))).toThrow(/<block>/);
  });

  it('throws on unknown template path', () => {
    const source =
      '<tdc><env count="1"></env><block><line><gen type="template" value="nonsense.path"/></line></block></tdc>';
    expect(() => render(parseStrict(source))).toThrow(/unknown template path/);
  });

  it('throws on unsupported gen type', () => {
    const source = '<tdc><env count="1"></env><block><line><gen type="zzz"/></line></block></tdc>';
    expect(() => render(parseStrict(source))).toThrow(/not yet supported/);
  });
});

describe('render — type="file" gen', () => {
  it('uses fileUniform when a <gen type="file" src="..."/> is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-render-file-'));
    const listPath = join(dir, 'names.txt');
    writeFileSync(listPath, 'Alice\nBob\nCarol\n');

    const source = `<tdc><env count="5" seed="674teyer74yTRGY7"></env><block><line><gen type="file" src="${listPath}"/></line></block></tdc>`;
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    for (const l of lines) {
      expect(['Alice', 'Bob', 'Carol']).toContain(l);
    }
  });

  it('can render inline values from a CSV column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-render-file-csv-'));
    const csvPath = join(dir, 'users.csv');
    writeFileSync(csvPath, 'first,email\nAlice,a@example.test\nBob,b@example.test\n');

    const source = `<tdc><env count="5" seed="csv"></env><block><line><gen type="file" src="${csvPath}" column="email"/></line></block></tdc>`;
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    for (const l of lines) {
      expect(['a@example.test', 'b@example.test']).toContain(l);
    }
  });

  it('can materialize sequence values from a CSV column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-render-file-csv-seq-'));
    const csvPath = join(dir, 'users.csv');
    writeFileSync(csvPath, 'first,email\nAlice,a@example.test\nBob,b@example.test\n');

    const source =
      `<tdc><env count="5" seed="csv-seq"><sequence name="Email">` +
      `<gen type="file" src="${csvPath}" column="email"/></sequence></env>` +
      '<block><line><data>${{Email}}</data></line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    for (const l of lines) {
      expect(['a@example.test', 'b@example.test']).toContain(l);
    }
  });

  it('throws when row-linked file mode is used inline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-render-file-row-inline-'));
    const csvPath = join(dir, 'users.csv');
    writeFileSync(csvPath, 'first,email\nAlice,a@example.test\n');

    const source = `<tdc><env count="1" seed="csv"></env><block><line><gen type="file" src="${csvPath}" column="email" row="person"/></line></block></tdc>`;
    expect(() => render(parseStrict(source), { now: FIXED_NOW })).toThrow(/sequence context/);
  });
});

describe('render — inline numeric and counter generators', () => {
  it('renders inline number generators deterministically', () => {
    const source =
      '<tdc><env count="4" seed="num-inline"></env><block><line>' +
      '<gen type="number" value="-5..5"/>' +
      '</line></block></tdc>';
    const a = render(parseStrict(source), { now: FIXED_NOW });
    const b = render(parseStrict(source), { now: FIXED_NOW });
    expect(a).toBe(b);

    const values = a
      .split('\n')
      .filter((l) => l.length > 0)
      .map(Number);
    expect(values).toHaveLength(4);
    for (const n of values) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(-5);
      expect(n).toBeLessThanOrEqual(5);
    }
  });

  it('renders inline fixed-length digit strings', () => {
    const source =
      '<tdc><env count="4" seed="num-digits"></env><block><line>' +
      '<gen type="number" length="10"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const values = out.split('\n').filter((l) => l.length > 0);
    expect(values).toHaveLength(4);
    for (const value of values) {
      expect(value).toHaveLength(10);
      expect(value).toMatch(/^[1-9]\d{9}$/);
    }
  });

  it('renders inline default digit, bit shorthand, and encoded-width ranges', () => {
    const source =
      '<tdc><env count="20" seed="num-minimal"></env><block><line>' +
      '<gen type="number"/><data>:</data>' +
      '<gen type="number" value="bit"/><data>:</data>' +
      '<gen type="number" value="0000..9999"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const values = out.split('\n').filter((l) => l.length > 0);
    expect(values).toHaveLength(20);
    expect(values.some((line) => line.split(':')[2]?.startsWith('0'))).toBe(true);
    for (const line of values) {
      const [digit, bit, padded] = line.split(':');
      expect(digit).toMatch(/^\d$/);
      expect(bit).toMatch(/^[01]$/);
      expect(padded).toMatch(/^\d{4}$/);
    }
  });

  it('renders inline regex generators deterministically', () => {
    const source =
      '<tdc regex_max_length="40"><env count="8" seed="regex-inline"></env><block><line>' +
      '<gen type="regex" value="([0-9]{3})-[A-Z]{2}-\\1"/>' +
      '</line></block></tdc>';
    const a = render(parseStrict(source), { now: FIXED_NOW });
    const b = render(parseStrict(source), { now: FIXED_NOW });
    expect(a).toBe(b);

    const values = a.split('\n').filter((l) => l.length > 0);
    expect(values).toHaveLength(8);
    for (const value of values) {
      expect(value).toMatch(/^([0-9]{3})-[A-Z]{2}-\1$/);
    }
  });

  it('honors local regex_max_length for inline regex generators', () => {
    const source =
      '<tdc><env count="2" seed="regex-inline-local-limit"></env><block><line>' +
      '<gen type="regex" value="[A-Z0-9]{40}" regex_max_length="40"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const values = out.split('\n').filter((l) => l.length > 0);
    expect(values).toHaveLength(2);
    for (const value of values) {
      expect(value).toMatch(/^[A-Z0-9]{40}$/);
    }
  });

  it('throws on invalid inline regex generators at render time', () => {
    const source =
      '<tdc><env count="1" seed="regex-inline-invalid"></env><block><line>' +
      '<gen type="regex" value="[a-z]+"/>' +
      '</line></block></tdc>';
    expect(() => render(parseStrict(source), { now: FIXED_NOW })).toThrow(/unbounded/);
  });

  it('throws when inline regex output exceeds the root safety limit', () => {
    const source =
      '<tdc regex_max_length="8"><env count="1" seed="regex-inline-too-long"></env><block><line>' +
      '<gen type="regex" value="[A-Z]{9}"/>' +
      '</line></block></tdc>';
    expect(() => render(parseStrict(source), { now: FIXED_NOW })).toThrow(/regex_max_length=8/);
  });

  it('renders inline symbol generators from named Unicode alphabets', () => {
    const source =
      '<tdc><env count="5" seed="symbol-inline"></env><block><line>' +
      '<gen type="symbol" alphabet="cyrillic.ru.letters" length="6"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const values = out.split('\n').filter((line) => line.length > 0);
    expect(values).toHaveLength(5);
    for (const value of values) {
      expect(value).toMatch(/^[А-ЯЁа-яё]{6}$/u);
    }
  });

  it('renders inline date generators', () => {
    const source =
      '<tdc><env count="4" seed="date-inline"></env><block><line>' +
      '<gen type="date" value="2026-05-01..2026-05-03" format="YYYY-MM-DD"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const values = out.split('\n').filter((line) => line.length > 0);
    expect(values).toHaveLength(4);
    for (const value of values) {
      expect(['2026-05-01', '2026-05-02', '2026-05-03']).toContain(value);
    }
  });

  it('renders inline advanced_regex without weighted choices', () => {
    const source =
      '<tdc regex_max_length="40"><env count="5" seed="advanced-regex-inline"></env><block><line>' +
      '<gen type="advanced_regex" value="([0-9]{3})-[A-Z]{2}-\\1"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    const values = out.split('\n').filter((line) => line.length > 0);
    expect(values).toHaveLength(5);
    for (const value of values) {
      expect(value).toMatch(/^([0-9]{3})-[A-Z]{2}-\1$/);
    }
  });

  it('rejects inline advanced_regex weighted choices', () => {
    const source =
      '<tdc><env count="5" seed="advanced-regex-inline-weighted"></env><block><line>' +
      '<gen type="advanced_regex" value="(?%{50:A;50:B})"/>' +
      '</line></block></tdc>';
    expect(() => render(parseStrict(source), { now: FIXED_NOW })).toThrow(/sequence context/);
  });

  it('keeps independent state for each inline counter occurrence', () => {
    const source =
      '<tdc><env count="3" seed="counter-inline"></env><block><line>' +
      '<gen type="increment" value="10" step="2"/><data>:</data>' +
      '<gen type="decrement" value="5" step="3"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    expect(out).toBe('10:5\n12:2\n14:-1\n');
  });

  it('advances inline counters only when the containing gen is rendered', () => {
    const source =
      '<tdc><env count="4" seed="counter-if"></env><block><line>' +
      '<gen type="increment" value="1" if="!_first"/>' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    expect(out).toBe('\n1\n2\n3\n');
  });
});

describe('render — interpolation', () => {
  it('substitutes ${{_count}} with 1-based iteration index', () => {
    const source =
      '<tdc><env count="3" seed="i" inject="${{%}}"></env><block><line><data>N=${{_count}}</data></line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    expect(out).toBe('N=1\nN=2\nN=3\n');
  });

  it('respects a custom inject pattern', () => {
    const source =
      '<tdc><env count="2" seed="i" inject="%{%}%"></env><block><line><data>%{_count}%</data></line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    expect(out).toBe('1\n2\n');
  });

  it('leaves unknown variable references untouched', () => {
    const source =
      '<tdc><env count="1" seed="i" inject="${{%}}"></env><block><line><data>hello ${{unknown}}</data></line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    expect(out).toBe('hello ${{unknown}}\n');
  });

  it('renders paired <data> with literal nested </data> text intact', () => {
    const source =
      '<tdc><env count="1" seed="i" inject="${{%}}"></env><block><line>' +
      '<data pair="doc">Example: <data>${{unknown}}</data></data pair="doc">' +
      '</line></block></tdc>';
    const out = render(parseStrict(source), { now: FIXED_NOW });
    expect(out).toBe('Example: <data>${{unknown}}</data>\n');
  });
});
