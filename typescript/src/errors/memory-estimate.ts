/**
 * Pre-render memory estimate.
 *
 * The render pipeline materializes every `<sequence>` into an array of
 * length `count` before the main loop starts. Some terminals also
 * materialize the rendered text into one large string (`toString()`),
 * while streaming terminals (`toIterator()`, `toStream()`, `writeFile()`,
 * CLI output) do not.
 *
 * This module computes a rough estimate of how many bytes the run will
 * need and compares it against the machine's TOTAL physical RAM. We gate
 * on total — not the OS's instantaneous "free" number — on purpose: modern
 * operating systems (macOS especially) keep RAM busy with reclaimable
 * caches and compressed pages, and hand it back the moment a process asks.
 * `os.freemem()` therefore under-reports usable memory by many times (on a
 * 32 GB Mac it can read <1 GB while ~13 GB is instantly reclaimable), which
 * would wrongly abort perfectly runnable jobs. What actually bounds a run is
 * how much fits in physical RAM before it thrashes — i.e. total memory.
 *
 * If the estimate is a large fraction of total RAM, we emit a *warning*
 * (the run may be slow / lean on swap but is allowed to proceed); only when
 * it can't plausibly fit at all do we escalate to an *error*.
 *
 * The estimate is deliberately rough: JavaScript string memory layout
 * depends on the engine, garbage-collector overhead is unknown, and
 * output size depends on the DSL template. We use wide safety margins
 * and err on the side of over-reporting.
 */

import { freemem, totalmem } from 'node:os';

import { humanBytes } from '../human-bytes.js';

import type { Diagnostic } from './diagnostic.js';

export interface MemoryEstimate {
  /** Estimated peak bytes the run will need. */
  readonly estimatedBytes: number;
  /** Estimated bytes held by materialized sequence arrays. */
  readonly sequenceBytes?: number;
  /** Estimated bytes held by the complete rendered output string, if included. */
  readonly renderedOutputBytes?: number;
  /** Whether the estimate includes a complete rendered output string. */
  readonly includesRenderedOutput?: boolean;
  /** Total physical RAM of the machine — the real ceiling a run competes for. */
  readonly totalBytes: number;
  /**
   * Free RAM reported by the OS at estimation time. Kept for context in the
   * message only; it does NOT drive the warn/error decision (see module doc:
   * `freemem()` under-reports usable memory because the OS reclaims caches on
   * demand). May be absent when only a total-based ratio was supplied.
   */
  readonly freeBytes?: number;
  /** Fraction of TOTAL RAM the estimate represents (0 to 1+). */
  readonly ratio: number;
}

export interface MemoryEstimateOptions {
  /**
   * `materialized` includes the complete rendered output string, matching
   * `TDC.toString()`. `streaming` excludes it, matching `toIterator()`,
   * `toStream()`, `writeFile()`, and the CLI.
   */
  readonly output?: 'materialized' | 'streaming';
  /**
   * `memory` (Engine 1, default) materializes each sequence into an array of
   * length `count`, so registry memory scales with `count`. `stream`
   * (Engine 2, `mode="stream"` / `--stream`) computes each value lazily per
   * row, so registry memory is O(number of sequence slots) — independent of
   * `count`. A large `count` under Engine 2 is NOT a memory risk.
   */
  readonly engine?: 'memory' | 'stream';
}

/**
 * Very coarse per-cell estimate in bytes. V8 stores short strings as
 * contiguous bytes with a small header; a typical generated value
 * (name, number, short date) lands in the 20–40 byte range after
 * header overhead.
 */
const BYTES_PER_CELL = 40;

/**
 * Estimated per-card rendered output size in bytes. This covers the
 * literal text and the substituted values. We use a generous default
 * that roughly matches the example fixtures.
 */
const BYTES_PER_RENDERED_CARD = 200;

/**
 * Emit a *warning* once the estimate reaches this fraction of TOTAL RAM: the
 * run will use a big share of the machine and may lean on swap / slow down if
 * other apps are busy, but it can still complete.
 */
const WARN_RATIO = 0.5;

/**
 * Escalate to an *error* (advise aborting) once the estimate reaches this
 * fraction of TOTAL RAM: even with on-demand reclamation it can't plausibly
 * fit, so the run will thrash or crash. Headroom below 1.0 leaves room for the
 * OS, other processes, and the estimate's own roughness.
 */
const ERROR_RATIO = 0.9;

/**
 * Compute a rough memory estimate for a planned render and, if the
 * estimate is alarming, return a diagnostic warning. `sequencesCount`
 * includes built-ins (`_count`, `_first`, `_last`, `_total`) plus every
 * `<sequence>` declared in `<env>`. For compound sequences, count each
 * *field* as a separate sequence — that's what the registry stores.
 */
export function estimateMemoryUsage(
  cardCount: number,
  sequencesCount: number,
  options: MemoryEstimateOptions = {},
): MemoryEstimate {
  // Engine 1 materializes count × sequencesCount cells; Engine 2 (stream)
  // holds one lazy resolver per slot — O(sequencesCount), independent of count.
  const sequenceBytes =
    options.engine === 'stream'
      ? sequencesCount * BYTES_PER_CELL
      : cardCount * sequencesCount * BYTES_PER_CELL;
  // Rendered output (accumulated into a single string). The stream engine
  // always writes card-by-card, so it never holds the full output either.
  const includesRenderedOutput = options.engine !== 'stream' && options.output !== 'streaming';
  const outputBytes = includesRenderedOutput ? cardCount * BYTES_PER_RENDERED_CARD : 0;

  const estimatedBytes = sequenceBytes + outputBytes;
  // Gate on TOTAL physical RAM, not freemem(): the OS reclaims caches/compressed
  // pages on demand, so total is what actually bounds the run (see module doc).
  const totalBytes = totalmem();
  const freeBytes = freemem();
  const ratio = totalBytes > 0 ? estimatedBytes / totalBytes : Infinity;

  return {
    estimatedBytes,
    sequenceBytes,
    renderedOutputBytes: outputBytes,
    includesRenderedOutput,
    totalBytes,
    freeBytes,
    ratio,
  };
}

/**
 * Produce a diagnostic warning when the estimate looks risky. Returns
 * `undefined` when the estimate is comfortably within safe bounds.
 */
export function memoryWarning(estimate: MemoryEstimate): Diagnostic | undefined {
  if (estimate.ratio < WARN_RATIO) return undefined;
  const est = humanBytes(estimate.estimatedBytes);
  const total = humanBytes(estimate.totalBytes);
  const severity = estimate.ratio >= ERROR_RATIO ? 'error' : 'warning';
  return {
    severity,
    source: 'render',
    line: 1,
    column: 0,
    message:
      severity === 'error'
        ? `estimated memory need (~${est}) exceeds this machine's RAM (${total}) — run will likely thrash or crash`
        : `estimated memory need (~${est}) is a large share of this machine's RAM (${total}) — may lean on swap and slow down`,
    hint:
      severity === 'error'
        ? 'Reduce `count`, split the generation into smaller batches, or switch to disk mode (`mode="disk"`) which is bounded-memory.'
        : 'This will still run; for very large datasets `mode="disk"` (Engine 2/3) keeps memory flat regardless of count.',
    code: severity === 'error' ? 'TDC201' : 'TDC200',
  };
}
