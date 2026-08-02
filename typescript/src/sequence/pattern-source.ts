/**
 * Reading a `<gen type="pattern">` drawing, whatever it was drawn in.
 *
 * The attributes name a shape three different ways — points typed inline, a
 * corridor between an upper and a lower line, or a file (SVG or PNG) that is
 * measured for its highest and lowest point at each position. This module turns
 * all three into the one `PatternGen` the engines sample, and remembers the
 * answer so a file is read once per render rather than once per row.
 */

import { readFileSync } from 'node:fs';

import { resolveExistingDataSourcePath, type DataSourceOptions } from '../data-source/index.js';
import {
  asDensity,
  corridorFromAttrs,
  parseMode,
  parsePoints,
  type PatternGen,
  patternFromEnvelope,
  rasterPatternGen,
  signalCurveFromAttrs,
  spreadFromAttrs,
} from '../generators/pattern.js';
import { decodePng, isPng } from '../generators/png.js';
import { svgEnvelope } from '../generators/svg-path.js';

import type { GenSpec } from './types.js';

/** Pattern gens are stable per render; cache so an `src` SVG file is read once. */
const patternGenCache = new WeakMap<GenSpec, PatternGen>();

/**
 * Resolve a pattern gen (cached per render). `upper` (± `lower`) → corridor;
 * otherwise `points`/`src` → a single-curve signal.
 */
export function patternGenForGen(gen: GenSpec, dataSources: DataSourceOptions): PatternGen {
  const cached = patternGenCache.get(gen);
  if (cached) return cached;
  const pg = readPatternGen(gen, dataSources);
  // `mode="density"` asks a different question of the SAME drawing (how often a
  // value occurs, instead of which card gets it), so it is applied once here,
  // after whichever reader produced the curve.
  const out = parseMode(gen.attrs['mode']) === 'density' ? asDensity(pg) : pg;
  patternGenCache.set(gen, out);
  return out;
}

function readPatternGen(gen: GenSpec, dataSources: DataSourceOptions): PatternGen {
  const upperRaw = gen.attrs['upper'];
  let pg: PatternGen;
  if (upperRaw !== undefined && upperRaw.trim() !== '') {
    const lowerRaw = gen.attrs['lower'];
    const lowerPts =
      lowerRaw !== undefined && lowerRaw.trim() !== '' ? parsePoints(lowerRaw) : undefined;
    pg = {
      kind: 'corridor',
      corridor: corridorFromAttrs(gen.attrs, parsePoints(upperRaw), lowerPts),
      spread: spreadFromAttrs(gen.attrs),
    };
  } else {
    const pointsRaw = gen.attrs['points'];
    let points: readonly (readonly [number, number])[];
    if (pointsRaw !== undefined && pointsRaw.trim() !== '') {
      points = parsePoints(pointsRaw);
    } else {
      const src = gen.attrs['src'];
      if (src === undefined || src.trim() === '') {
        throw new Error(
          'sequence: <gen type="pattern"> needs "points"/"src", or "upper"[/"lower"]',
        );
      }
      const path = resolveExistingDataSourcePath(src, dataSources).path;
      const bytes = readFileSync(path);
      if (isPng(bytes)) return rasterPatternGen(decodePng(bytes), gen.attrs);
      // A vector file is measured exactly like a picture: highest and lowest
      // point at each position. One stroke → exact values; two strokes or a
      // closed outline → a band, and a file may switch from one to the other.
      const env = svgEnvelope(bytes.toString('utf8'));
      return patternFromEnvelope(env.top, env.bottom, gen.attrs);
    }
    pg = {
      kind: 'signal',
      curve: signalCurveFromAttrs(gen.attrs, points),
      spread: spreadFromAttrs(gen.attrs),
    };
  }
  return pg;
}
