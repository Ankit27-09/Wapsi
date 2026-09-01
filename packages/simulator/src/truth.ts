import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { BPS_ONE, ReasonCodeSchema, bps, type Bps, type ReasonCode } from '@rc/core';
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
] as const;

export type TruthTiming = (typeof TRUTH_TIMINGS)[number];

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
  p_bps: z.number().int().min(0).max(BPS_ONE),
});

const TruthFileSchema = z.object({
  version: z.number().int().min(1),
  issuers: z.array(IssuerSchema).min(1),
  structural_zeros: z.array(ReasonCodeSchema),
  truth: z.array(TruthRowSchema).min(1),
});

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
  ): Bps;

  /** Roll against `successProbability`. The only source of outcome randomness. */
  attemptSucceeds(
    rng: Rng,
    code: ReasonCode,
    attempt: number,
    timing: TruthTiming,
    issuerId: string,
  ): boolean;

  issuerById(id: string): Issuer;

  /** Weighted issuer choice, for assigning one to a synthetic customer. */
  pickIssuer(rng: Rng): Issuer;
}

const key = (code: ReasonCode, attempt: number, timing: TruthTiming): string =>
  `${code}|${attempt}|${timing}`;

export function buildTruthModel(raw: unknown): TruthModel {
  const parsed = TruthFileSchema.parse(raw);

  const byKey = new Map<string, number>();
  for (const row of parsed.truth) {
    const k = key(row.reason_code, row.attempt, row.timing);
    if (byKey.has(k)) throw new Error(`Duplicate truth row for ${k} in priors.truth.yaml`);
    byKey.set(k, row.p_bps);
  }

  const zeros = new Set<ReasonCode>(parsed.structural_zeros);
  for (const row of parsed.truth) {
    if (zeros.has(row.reason_code)) {
      throw new Error(
        `${row.reason_code} is a structural zero but has a truth row; one of the two is wrong`,
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
  ): Bps => {
    if (zeros.has(code) || code === 'unknown') return bps(0);

    const base = byKey.get(key(code, attempt, timing));
    if (base === undefined) return bps(0);

    // Integer throughout, and clamped: a multiplier above 10_000 must not be able to
    // push a probability past certainty.
    const scaled = Math.floor((base * issuerById(issuerId).multiplier_bps) / BPS_ONE);
    return bps(Math.min(BPS_ONE, Math.max(0, scaled)));
  };

  return {
    version: parsed.version,
    issuers: parsed.issuers,
    successProbability,
    attemptSucceeds: (rng, code, attempt, timing, issuerId) =>
      rng.chance(successProbability(code, attempt, timing, issuerId)),
    issuerById,
    pickIssuer: (rng) => rng.weighted(weightedIssuers),
  };
}

export function loadTruthModel(path?: string): TruthModel {
  const file = path ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'priors.truth.yaml');
  return buildTruthModel(parse(readFileSync(file, 'utf8')));
}
