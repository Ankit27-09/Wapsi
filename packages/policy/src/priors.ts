import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { BpsSchema, ReasonCodeSchema, type Bps, type ReasonCode } from '@rc/core';

/**
 * The policy engine's published success priors.
 *
 * Loaded from `priors.published.yaml`, validated on the way in, and exposed through a
 * lookup that cannot silently invent a value. If the policy asks for a prior that is not
 * in the table, that is a bug in the policy â€” so `prior()` returns an explicit
 * discriminated result rather than a plausible default. A default here would be an
 * unsourced number entering the money path through the widest possible door.
 *
 * This module must never import from @rc/simulator. See `.dependency-cruiser.cjs`.
 */

// ---------------------------------------------------------------------------
// Timing buckets
// ---------------------------------------------------------------------------
// Coarse on purpose. A prior table with a row per hour would imply precision no public
// source supports, and would make the sensitivity sweep meaningless by burying the real
// uncertainty in false granularity.

export const TIMINGS = [
  'immediate',
  'short_backoff',
  'medium_backoff',
  'next_day',
  'salary_window',
  'alt_rail',
] as const;

export type Timing = (typeof TIMINGS)[number];
export const TimingSchema = z.enum(TIMINGS);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * A citation, or the explicit admission that there isn't one.
 *
 * `ASSUMED` is a first-class value rather than a missing field, because a missing field
 * reads as an oversight and this is a decision. Assumed rows must say why, and they are
 * automatically given the wider perturbation band.
 */
const SourceSchema = z.union([
  z.literal('ASSUMED'),
  z.object({
    ref: z.string().min(1),
    retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

const PriorRowSchema = z
  .object({
    reason_code: ReasonCodeSchema,
    attempt: z.number().int().min(1).max(5),
    timing: TimingSchema,
    p_bps: BpsSchema,
    source: SourceSchema,
    assumption: z.string().min(1).optional(),
  })
  .refine((row) => row.source !== 'ASSUMED' || row.assumption !== undefined, {
    message: 'A prior marked ASSUMED must state its assumption',
    path: ['assumption'],
  });

const StructuralZeroSchema = z.object({
  reason_code: ReasonCodeSchema,
  why: z.string().min(1),
});

const PriorsFileSchema = z.object({
  version: z.number().int().min(1),
  bands: z.object({
    cited_pct: z.number().int().min(1).max(100),
    assumed_pct: z.number().int().min(1).max(100),
  }),
  timings: z.record(z.string()),
  structural_zeros: z.array(StructuralZeroSchema),
  priors: z.array(PriorRowSchema).min(1),
});

export type PriorRow = z.infer<typeof PriorRowSchema>;
export type Source = z.infer<typeof SourceSchema>;

// ---------------------------------------------------------------------------
// Lookup result
// ---------------------------------------------------------------------------

/**
 * Why this is a union and not `Bps | undefined`.
 *
 * The three outcomes are genuinely different and the caller must handle them
 * differently: a real prior feeds the gate, a structural zero means refuse without
 * spending anything, and a missing entry is a bug that must surface rather than be
 * coerced to zero. Collapsing the last two would make a policy misconfiguration look
 * exactly like a correct refusal.
 */
export type PriorLookup =
  | { readonly kind: 'prior'; readonly pBps: Bps; readonly assumed: boolean }
  | { readonly kind: 'structural_zero'; readonly why: string }
  | { readonly kind: 'missing'; readonly detail: string };

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export interface PriorTable {
  readonly version: number;
  readonly bands: { readonly citedPct: number; readonly assumedPct: number };
  /** Every row, for the sensitivity sweep to perturb. */
  readonly rows: readonly PriorRow[];
  readonly structuralZeros: ReadonlyMap<ReasonCode, string>;
  prior(code: ReasonCode, attempt: number, timing: Timing): PriorLookup;
  /** Perturbation band for a row, in percent. Assumed rows get the wider one. */
  bandPctFor(row: PriorRow): number;
}

const key = (code: ReasonCode, attempt: number, timing: Timing): string =>
  `${code}|${attempt}|${timing}`;

export function buildPriorTable(raw: unknown): PriorTable {
  const parsed = PriorsFileSchema.parse(raw);

  const byKey = new Map<string, PriorRow>();
  for (const row of parsed.priors) {
    const k = key(row.reason_code, row.attempt, row.timing);
    if (byKey.has(k)) {
      // Two priors for one situation means the table disagrees with itself, and which
      // one wins would depend on file order. Refuse at load rather than pick.
      throw new Error(`Duplicate prior for ${k} in priors.published.yaml`);
    }
    byKey.set(k, row);
  }

  const structuralZeros = new Map<ReasonCode, string>(
    parsed.structural_zeros.map((entry) => [entry.reason_code, entry.why]),
  );

  // A code cannot be both structurally impossible and have a success prior. If it were,
  // the gate's answer would depend on which lookup ran first.
  for (const row of parsed.priors) {
    const zero = structuralZeros.get(row.reason_code);
    if (zero !== undefined) {
      throw new Error(
        `${row.reason_code} is declared a structural zero but also has a prior ` +
          `(attempt ${row.attempt}, ${row.timing}). One of the two is wrong.`,
      );
    }
  }

  return {
    version: parsed.version,
    bands: { citedPct: parsed.bands.cited_pct, assumedPct: parsed.bands.assumed_pct },
    rows: parsed.priors,
    structuralZeros,

    prior(code, attempt, timing) {
      const zero = structuralZeros.get(code);
      if (zero !== undefined) return { kind: 'structural_zero', why: zero };

      const row = byKey.get(key(code, attempt, timing));
      if (row === undefined) {
        return {
          kind: 'missing',
          detail: `No published prior for ${code} attempt ${attempt} at ${timing}`,
        };
      }

      return { kind: 'prior', pBps: row.p_bps, assumed: row.source === 'ASSUMED' };
    },

    bandPctFor(row) {
      return row.source === 'ASSUMED' ? parsed.bands.assumed_pct : parsed.bands.cited_pct;
    },
  };
}

/**
 * Load and validate the shipped prior table.
 *
 * Read synchronously at module scope by callers because a policy engine with no priors
 * has nothing to decide with â€” failing at startup is correct, and deferring the failure
 * to the first decision would mean discovering a malformed table mid-batch.
 */
export function loadPriorTable(path?: string): PriorTable {
  const file =
    path ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'priors.published.yaml');
  return buildPriorTable(parse(readFileSync(file, 'utf8')));
}
