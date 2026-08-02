import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const NO_SEED = `<tdc><env count="3" inject="\${{%}}"><sequence name="N"><gen type="number" value="100..999"/></sequence></env><block><line><data>\${{N}}</data></line></block></tdc>`;
const ENV_SEED = `<tdc><env count="3" seed="from-env" inject="\${{%}}"><sequence name="N"><gen type="number" value="100..999"/></sequence></env><block><line><data>\${{N}}</data></line></block></tdc>`;

describe('TDC.seedInfo — effective seed resolution', () => {
  it('flags a generated seed when none is provided anywhere', () => {
    const info = new TDC({ configString: NO_SEED }).seedInfo();
    expect(info.generated).toBe(true);
    expect(info.seed.length).toBeGreaterThan(0);
  });

  it('uses the explicit option seed and marks it not-generated', () => {
    const info = new TDC({ configString: NO_SEED, seed: 'explicit' }).seedInfo();
    expect(info).toEqual({ seed: 'explicit', generated: false });
  });

  it('falls back to the <env seed="…"> attribute, not-generated', () => {
    const info = new TDC({ configString: ENV_SEED }).seedInfo();
    expect(info).toEqual({ seed: 'from-env', generated: false });
  });

  it('option seed overrides the env seed', () => {
    const info = new TDC({ configString: ENV_SEED, seed: 'override' }).seedInfo();
    expect(info).toEqual({ seed: 'override', generated: false });
  });

  it('caches the generated seed so repeated terminals reproduce output', () => {
    // With no seed, a random one is generated ONCE and cached — so two
    // toString() calls on the same instance must produce identical output
    // (previously each render rolled a fresh Math.random()).
    const tdc = new TDC({ configString: NO_SEED });
    const a = tdc.toString();
    const b = tdc.toString();
    expect(a).toBe(b);
  });

  it('re-running with the reported generated seed reproduces the output', () => {
    const first = new TDC({ configString: NO_SEED });
    const seed = first.seedInfo().seed;
    const reproduced = new TDC({ configString: NO_SEED, seed }).toString();
    expect(reproduced).toBe(first.toString());
  });
});
