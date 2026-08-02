import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanPacks } from '../../src/data-pack/index.js';

/**
 * Roots are scanned LOW→HIGH priority, so a later root shadows an earlier one
 * for the same address. This is what lets a downloaded or project pack override
 * the bundled one instead of colliding — the exact failure the download test
 * surfaced (`common.book.isbn10` declared by both bundled and downloaded).
 *
 * A collision WITHIN one root stays a real error.
 */

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'packroot-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const value = (address: string, list: string): string => `---\naddress: ${address}\n---\n${list}\n`;

describe('pack roots — priority override across roots', () => {
  it('a later root overrides an earlier one for the same address, no error', () => {
    const low = root({ 'a.txt': value('common.demo.color', 'red\ngreen') });
    const high = root({ 'a.txt': value('common.demo.color', 'gold\nsilver') });

    const { registry, diagnostics } = scanPacks([low, high]);
    expect(diagnostics).toEqual([]);
    expect(registry.get('common.demo.color')?.values).toEqual(['gold', 'silver']);
  });

  it('order decides the winner', () => {
    const low = root({ 'a.txt': value('common.demo.color', 'red') });
    const high = root({ 'a.txt': value('common.demo.color', 'gold') });

    // Reverse the priority: now `low` is the higher-priority (later) root.
    const { registry } = scanPacks([high, low]);
    expect(registry.get('common.demo.color')?.values).toEqual(['red']);
  });

  it('non-colliding addresses from every root all survive', () => {
    const low = root({ 'a.txt': value('common.demo.a', 'x') });
    const high = root({ 'b.txt': value('common.demo.b', 'y') });

    const { registry } = scanPacks([low, high]);
    expect(registry.get('common.demo.a')?.values).toEqual(['x']);
    expect(registry.get('common.demo.b')?.values).toEqual(['y']);
  });

  it('a duplicate WITHIN one root is still an error', () => {
    const dir = root({
      'a.txt': value('common.demo.color', 'red'),
      'b.txt': value('common.demo.color', 'gold'),
    });
    const { diagnostics } = scanPacks([dir]);
    expect(diagnostics.map((d) => d.message).join(' ')).toContain('duplicate data-pack address');
  });
});
