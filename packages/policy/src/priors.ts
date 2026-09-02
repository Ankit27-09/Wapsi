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
  // The three buckets below are not retry backoffs. They exist because the timing that
  // matters is a property of the DOMAIN, not of exponential decay: an e-mandate debit must
  // be preceded by a notification a day ahead, a B2B invoice is paid when the buyer's
  // payment run executes, and a broken promise is followed up the day after it broke.
  'pre_debit_window',
  'payment_run_window',
  'promise_followup',
  /**
   * Five days out — the last point inside the permitted e-mandate retry window.
   *
   * Exists because the pre-debit notification has a knock-on effect worth naming: once a
   * debit must be preceded by 24 hours of notice, every sub-day backoff is legally
   * unavailable on a mandate rail. An issuer outage that a one-off payment recovers in
   * fifteen minutes cannot be chased that way on a subscription at all.
   */
  'late_window',
] as const;

export type Timing = (typeof TIMINGS)[number];
export const TimingSchema = z.enum(TIMINGS);

/**
 * What a prior is a probability OF.
 *
 * A prior used to be keyed on (cause, attempt, timing) alone, which quietly assumed every
 * attempt was a re-presentment of a charge. Once the same engine also sends payment links,
 * pre-debit notifications and re-authorisation requests, that assumption is wrong in a way
 * that cannot be papered over: "will a retry succeed at hour 72" and "will this customer
 * re-authorise their mandate" are different questions about the same transaction.
 *
 * `charge` deliberately covers both `retry` and `switch_rail`. For an action that presents a
 * charge, the attempt number and the timing are the whole story — which rail it lands on is
 * already carried by the timing bucket (`alt_rail`), so splitting them would create two
 * table rows that must always agree.
 */
export const PRIOR_KINDS = [
  'charge',
  'payment_link',
  'notify',
  'pre_debit_notify',
  'remandate',
] as const;

export type PriorKind = (typeof PRIOR_KINDS)[number];
export const PriorKindSchema = z.enum(PRIOR_KINDS);

/** The prior kind a schedule action asks about. */
export function priorKindFor(action: string): PriorKind {
  switch (action) {
    case 'retry':
    case 'switch_rail':
      return 'charge';
    case 'payment_link':
      return 'payment_link';
    case 'notify':
      return 'notify';
    case 'pre_debit_notify':
      return 'pre_debit_notify';
    case 'remandate':
      return 'remandate';
    default:
      throw new Error(`No prior kind defined for action "${action}"`);
  }
}

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
    /** Omitted means `charge`, so every pre-existing retry row keeps its meaning. */
    kind: PriorKindSchema.default('charge'),
    p_bps: BpsSchema,
    source: SourceSchema,
    assumption: z.string().min(1).optional(),
  })
  .refine((row) => row.source !== 'ASSUMED' || row.assumption !== undefined, {
    message: 'A prior marked ASSUMED must state its assumption',
    path: ['assumption'],
  });

/**
 * A structural zero, and what it is zero for.
 *
 * `charging` means no re-presentment can succeed — the card is expired, the mandate is
 * revoked — while leaving room for a non-charging intervention that has a genuine, non-zero
 * chance. That distinction is the whole point: "cannot be retried" and "cannot be recovered"
 * are different claims, and conflating them writes off money that a nudge would collect.
 *
 * `all` means nothing may fire at all, for reasons of risk or ignorance rather than
 * mechanism, and any prior for that code is a contradiction.
 */
const StructuralZeroSchema = z.object({
  reason_code: ReasonCodeSchema,
  scope: z.enum(['charging', 'all']),
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
  /** Codes no charging attempt can recover, and why. Includes the `all` ones. */
  readonly structuralZeros: ReadonlyMap<ReasonCode, string>;
  prior(code: ReasonCode, attempt: number, timing: Timing, kind?: PriorKind): PriorLookup;
  /** Perturbation band for a row, in percent. Assumed rows get the wider one. */
  bandPctFor(row: PriorRow): number;
}

const key = (code: ReasonCode, attempt: number, timing: Timing, kind: PriorKind): string =>
  `${code}|${attempt}|${timing}|${kind}`;

export function buildPriorTable(raw: unknown): PriorTable {
  const parsed = PriorsFileSchema.parse(raw);

  const byKey = new Map<string, PriorRow>();
  for (const row of parsed.priors) {
    const k = key(row.reason_code, row.attempt, row.timing, row.kind);
    if (byKey.has(k)) {
      // Two priors for one situation means the table disagrees with itself, and which
      // one wins would depend on file order. Refuse at load rather than pick.
      throw new Error(`Duplicate prior for ${k} in priors.published.yaml`);
    }
    byKey.set(k, row);
  }

  const zeroScopes = new Map<ReasonCode, 'charging' | 'all'>(
    parsed.structural_zeros.map((entry) => [entry.reason_code, entry.scope]),
  );
  const structuralZeros = new Map<ReasonCode, string>(
    parsed.structural_zeros.map((entry) => [entry.reason_code, entry.why]),
  );

  // A code cannot be both structurally impossible and have a success prior for the same
  // thing. If it were, the gate's answer would depend on which lookup ran first.
  for (const row of parsed.priors) {
    const scope = zeroScopes.get(row.reason_code);
    if (scope === 'all' || (scope === 'charging' && row.kind === 'charge')) {
      throw new Error(
        `${row.reason_code} is declared a structural zero (scope: ${scope}) but also has a ` +
          `${row.kind} prior (attempt ${row.attempt}, ${row.timing}). One of the two is wrong.`,
      );
    }
  }

  return {
    version: parsed.version,
    bands: { citedPct: parsed.bands.cited_pct, assumedPct: parsed.bands.assumed_pct },
    rows: parsed.priors,
    structuralZeros,

    prior(code, attempt, timing, kind = 'charge') {
      const scope = zeroScopes.get(code);
      if (scope === 'all' || (scope === 'charging' && kind === 'charge')) {
        const why = structuralZeros.get(code);
        if (why === undefined) throw new Error(`unreachable: zero scope without reason for ${code}`);
        return { kind: 'structural_zero', why };
      }

      const row = byKey.get(key(code, attempt, timing, kind));
      if (row === undefined) {
        return {
          kind: 'missing',
          detail: `No published prior for ${code} attempt ${attempt} at ${timing} (${kind})`,
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
