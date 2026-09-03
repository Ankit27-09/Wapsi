import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { BPS_ONE, RailSchema, ReasonCodeSchema, bps, type Bps, type ReasonCode } from '@rc/core';
import type { Rng } from './rng.js';

/**
 * The ground-truth outcome model.
 *
 * What the world actually does. Loaded from `priors.truth.yaml`, which is deliberately
 * different from the policy's published priors — see the header of that file for the two
 * ways in which it differs and why both are realistic.
 *
 * Two consumers, and only two:
 *
 *   - The gateway simulator, to decide whether an attempt succeeds.
 *   - The oracle arm (B3), which is allowed to read this as a decision input and play
 *     perfectly against it. That is what turns the headline claim from "we beat naive
 *     retry" into "we captured X% of what was achievable".
 *
 * `@rc/policy` cannot import this package. `pnpm lint:boundaries` fails the build.
 */

// The timing vocabulary is duplicated here rather than imported from @rc/policy, because
// importing it would breach the wall. That duplication is the cost of the guarantee, and
// it is cheap: `truthCoversPolicyTimings` in the tests asserts the two stay in step, so a
// drift is a test failure rather than a silent mismatch.
const TRUTH_TIMINGS = [
  'immediate',
  'short_backoff',
  'medium_backoff',
  'next_day',
  'salary_window',
  'alt_rail',
  'pre_debit_window',
  'payment_run_window',
  'promise_followup',
  'late_window',
] as const;

export type TruthTiming = (typeof TRUTH_TIMINGS)[number];

/** Mirrors `PriorKind` in @rc/policy, duplicated for the same reason as the timings. */
const TRUTH_KINDS = ['charge', 'payment_link', 'notify', 'pre_debit_notify', 'remandate'] as const;

export type TruthKind = (typeof TRUTH_KINDS)[number];

const IssuerSchema = z.object({
  id: z.string().min(1),
  weight: z.number().int().min(0),
  multiplier_bps: z.number().int().min(0).max(30_000),
  note: z.string().min(1),
});

const TruthRowSchema = z.object({
  reason_code: ReasonCodeSchema,
  attempt: z.number().int().min(1).max(5),
  timing: z.enum(TRUTH_TIMINGS),
  kind: z.enum(TRUTH_KINDS).default('charge'),
  p_bps: z.number().int().min(0).max(BPS_ONE),
});

const TruthZeroSchema = z.object({
  reason_code: ReasonCodeSchema,
  scope: z.enum(['charging', 'all']),
});

/**
 * A transient degradation episode. The detector's answer key.
 *
 * Distinct from an issuer's `multiplier_bps`, which is a permanent quality difference. This
 * is "for these ninety minutes, this cohort was broken" — a different fact needing a
 * different response, and the only one a detector can find.
 */
const OutageSchema = z.object({
  issuer_id: z.string().min(1),
  rail: RailSchema,
  start_offset_minutes: z.number().int().min(0),
  duration_minutes: z.number().int().min(1),
  failure_bps: z.number().int().min(0).max(BPS_ONE),
  dominant_code: ReasonCodeSchema,
  /**
   * Whether a detector SHOULD report this.
   *
   * False marks a trap: an elevation that is statistically real and operationally
   * immaterial. Excluded from the recall set, so missing it is free — and since the scorer
   * treats any signal matching no material episode as a false positive, reporting it costs
   * precision. Without this flag the answer key could only reward sensitivity, and a
   * detector tuned to alert on everything would score perfectly.
   */
  material: z.boolean().default(true),
  note: z.string().min(1),
});

const TruthFileSchema = z.object({
  version: z.number().int().min(1),
  issuers: z.array(IssuerSchema).min(1),
  outages: z.array(OutageSchema).default([]),
  structural_zeros: z.array(TruthZeroSchema),
  truth: z.array(TruthRowSchema).min(1),
});

export type Outage = z.infer<typeof OutageSchema>;

export type Issuer = z.infer<typeof IssuerSchema>;

export interface TruthModel {
  readonly version: number;
  readonly issuers: readonly Issuer[];

  /**
   * The real probability of success, after the issuer's unobserved effect.
   *
   * Returns zero for a structural zero and for any situation the truth table does not
   * cover. Zero-for-uncovered is safe here in a way it would not be in the policy: an
   * uncovered situation means the world offers no path to success, which is exactly what
   * a probability of zero says. The policy's equivalent lookup deliberately returns
   * `missing` instead, because there a gap is a misconfiguration rather than a fact.
   */
  successProbability(
    code: ReasonCode,
    attempt: number,
    timing: TruthTiming,
    issuerId: string,
    kind?: TruthKind,
  ): Bps;

  /** Roll against `successProbability`. The only source of outcome randomness. */
  attemptSucceeds(
    rng: Rng,
    code: ReasonCode,
    attempt: number,
    timing: TruthTiming,
    issuerId: string,
    kind?: TruthKind,
  ): boolean;

  issuerById(id: string): Issuer;

  /** Weighted issuer choice, for assigning one to a synthetic customer. */
  pickIssuer(rng: Rng): Issuer;

  /**
   * The degradation episodes this world contains.
   *
   * Read by the authorisation-stream generator, which makes them happen, and by the
   * detection scorer, which grades against them. NEVER by @rc/detect, which has no
   * dependency on this package.
   */
  readonly outages: readonly Outage[];
}

const key = (code: ReasonCode, attempt: number, timing: TruthTiming, kind: TruthKind): string =>
  `${code}|${attempt}|${timing}|${kind}`;

export function buildTruthModel(raw: unknown): TruthModel {
  const parsed = TruthFileSchema.parse(raw);

  const byKey = new Map<string, number>();
  for (const row of parsed.truth) {
    const k = key(row.reason_code, row.attempt, row.timing, row.kind);
    if (byKey.has(k)) throw new Error(`Duplicate truth row for ${k} in priors.truth.yaml`);
    byKey.set(k, row.p_bps);
  }

  const zeros = new Map<ReasonCode, 'charging' | 'all'>(
    parsed.structural_zeros.map((entry) => [entry.reason_code, entry.scope]),
  );
  for (const row of parsed.truth) {
    const scope = zeros.get(row.reason_code);
    if (scope === 'all' || (scope === 'charging' && row.kind === 'charge')) {
      throw new Error(
        `${row.reason_code} is a structural zero (scope: ${scope}) but has a ${row.kind} truth ` +
          'row; one of the two is wrong',
      );
    }
  }

  const issuers = new Map(parsed.issuers.map((issuer) => [issuer.id, issuer]));
  const weightedIssuers = parsed.issuers.map((issuer) => ({ item: issuer, weight: issuer.weight }));

  const issuerById = (id: string): Issuer => {
    const issuer = issuers.get(id);
    if (issuer === undefined) throw new Error(`Unknown issuer ${id}`);
    return issuer;
  };

  const successProbability = (
    code: ReasonCode,
    attempt: number,
    timing: TruthTiming,
    issuerId: string,
    kind: TruthKind = 'charge',
  ): Bps => {
    const scope = zeros.get(code);
    if (scope === 'all' || (scope === 'charging' && kind === 'charge')) return bps(0);
    if (code === 'unknown') return bps(0);

    const base = byKey.get(key(code, attempt, timing, kind));
    if (base === undefined) return bps(0);

    // The issuer effect applies ONLY to an action that presents a charge. A co-operative
    // bank's flaky authorisation infrastructure is a real reason a retry fails; it has
    // nothing to do with whether a customer taps a payment link or re-authorises a
    // mandate. Applying the multiplier there would be modelling noise dressed as rigour.
    if (kind !== 'charge') return bps(Math.min(BPS_ONE, Math.max(0, base)));

    // Integer throughout, and clamped: a multiplier above 10_000 must not be able to
    // push a probability past certainty.
    const scaled = Math.floor((base * issuerById(issuerId).multiplier_bps) / BPS_ONE);
    return bps(Math.min(BPS_ONE, Math.max(0, scaled)));
  };

  return {
    version: parsed.version,
    issuers: parsed.issuers,
    successProbability,
    attemptSucceeds: (rng, code, attempt, timing, issuerId, kind) =>
      rng.chance(successProbability(code, attempt, timing, issuerId, kind)),
    issuerById,
    pickIssuer: (rng) => rng.weighted(weightedIssuers),
    outages: parsed.outages,
  };
}

export function loadTruthModel(path?: string): TruthModel {
  const file = path ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'priors.truth.yaml');
  return buildTruthModel(parse(readFileSync(file, 'utf8')));
}
