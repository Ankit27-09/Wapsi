import { bps, type Rail, type ReasonCode } from '@rc/core';
import type { Rng } from './rng.js';
import { deriveRng } from './rng.js';
import type { Issuer, Outage } from './truth.js';

/**
 * The merchant's authorisation stream — the thing a detector actually watches.
 *
 * WHY THIS IS NOT THE SAME DATASET AS THE RECOVERY CASES. The 300 transactions the rest of
 * this system works on are all failures, already triaged. A stream of failures has no
 * denominator, so no rate can be computed from it and no degradation can be found: "eleven
 * ISS_COOP cards failed this hour" is meaningless without knowing whether twelve or twelve
 * hundred were attempted.
 *
 * So this generates both outcomes, which is what a merchant's gateway reporting actually
 * gives them. The recovery cases are the subset of failures the merchant opened a case on —
 * that is a real distinction, not a modelling convenience, since nobody chases every decline.
 *
 * ONE DENSE TRADING BAND rather than the full seven-day span the transactions occupy. A
 * detector operates on recent traffic, and spreading realistic volume over a week would
 * either need six figures of rows to keep any cohort above a usable sample per window, or
 * leave every cohort too thin to conclude anything. Ten hours at merchant-scale volume is
 * both cheaper and closer to how the thing is really run.
 *
 * The episodes come from `priors.truth.yaml` and are ground truth. `@rc/detect` cannot see
 * them — it has no dependency on this package and the boundary linter enforces that — so
 * whether it finds them is a measurement.
 */

/** Where the dense band sits, in minutes from SIM_EPOCH. Day two of the generated span. */
export const STREAM_START_MINUTE = 1440;
export const STREAM_MINUTES = 600;

/**
 * Attempts per hour across all cohorts.
 *
 * Chosen from the detector's requirements rather than picked to look busy: the smallest
 * cohort (ISS_COOP at 10% of volume) needs to clear a 40-attempt floor inside a 30-minute
 * window, and card carries about 65% of traffic. 1400/hour puts ISS_COOP's card cohort at
 * roughly 45 per window — over the floor with little to spare, which is the honest place to
 * sit: a volume chosen so the detector comfortably wins would be choosing the answer.
 */
export const ATTEMPTS_PER_HOUR = 1400;

/** Background failure rate, in basis points. What a healthy book looks like. */
const BASELINE_FAILURE_BPS = 900;

/**
 * Rail mix. Card-heavy, because that is where re-presentment economics and degradation both
 * live — a UPI intent failure is a customer who closed an app, not an issuer having a
 * problem.
 */
const RAIL_MIX: readonly { readonly item: Rail; readonly weight: number }[] = [
  { item: 'card', weight: 65 },
  { item: 'upi_collect', weight: 12 },
  { item: 'upi_intent', weight: 10 },
  { item: 'netbanking', weight: 8 },
  { item: 'wallet', weight: 5 },
];

/** Card BIN buckets. Only card traffic has one. */
const BIN_BUCKETS = ['BIN_4213', 'BIN_5521', 'BIN_6073', 'BIN_4074'] as const;

/**
 * The causes a healthy book fails for, when it is not degrading.
 *
 * Weighted towards insufficient funds because that is what ordinary decline traffic is. The
 * point is that the BACKGROUND has a mixed cause distribution: a detector that keys on
 * "lots of failures" would fire on ordinary volume, and one that keys on "lots of failures
 * concentrated on one cause" will not.
 */
const BACKGROUND_CAUSES: readonly { readonly item: ReasonCode; readonly weight: number }[] = [
  { item: 'insufficient_funds', weight: 42 },
  { item: 'do_not_honour', weight: 24 },
  { item: 'network_timeout', weight: 12 },
  { item: 'threeds_timeout', weight: 10 },
  { item: 'card_expired', weight: 7 },
  { item: 'issuer_down', weight: 5 },
];

export interface PlannedAuthAttempt {
  readonly issuerId: string;
  readonly rail: Rail;
  readonly binBucket: string | null;
  readonly succeeded: boolean;
  readonly reasonCode: ReasonCode | null;
  readonly amountPaise: bigint;
  readonly occurredAt: Date;
}

/** The episode covering a cohort at an instant, if any. */
function outageAt(
  outages: readonly Outage[],
  epoch: Date,
  issuerId: string,
  rail: Rail,
  at: Date,
): Outage | null {
  const minute = (at.getTime() - epoch.getTime()) / 60_000;

  for (const outage of outages) {
    if (outage.issuer_id !== issuerId || outage.rail !== rail) continue;
    if (
      minute >= outage.start_offset_minutes &&
      minute < outage.start_offset_minutes + outage.duration_minutes
    ) {
      return outage;
    }
  }

  return null;
}

/**
 * Generate the stream.
 *
 * Deterministic from the seed on its own stream, so adding detection did not reshuffle a
 * single amount, cause or string already generated — the property that lets one change be
 * evaluated in isolation from the others.
 */
export function planAuthStream(
  seed: number,
  epoch: Date,
  issuers: readonly Issuer[],
  outages: readonly Outage[],
): readonly PlannedAuthAttempt[] {
  const rng: Rng = deriveRng(seed, 'auth_stream');

  const weightedIssuers = issuers.map((issuer) => ({ item: issuer, weight: issuer.weight }));
  const total = Math.round((ATTEMPTS_PER_HOUR * STREAM_MINUTES) / 60);
  const stream: PlannedAuthAttempt[] = [];

  for (let i = 0; i < total; i += 1) {
    // Evenly spaced rather than Poisson. Arrival-time realism buys nothing here — the
    // detector aggregates into 30-minute windows, so it cannot tell the difference — and
    // clustering would make cohort-per-window counts vary enough that a threshold test
    // would be measuring the arrival process rather than the detector.
    const minute = STREAM_START_MINUTE + (i * STREAM_MINUTES) / total;
    const occurredAt = new Date(epoch.getTime() + minute * 60_000);

    const issuer = rng.weighted(weightedIssuers);
    const rail = rng.weighted(RAIL_MIX);
    const binBucket = rail === 'card' ? rng.pick(BIN_BUCKETS) : null;

    const episode = outageAt(outages, epoch, issuer.id, rail, occurredAt);

    // During an episode the cohort's failure rate is the episode's, and its failures
    // concentrate on the episode's cause. Outside one, the issuer's own standing quality
    // tilts the baseline a little — a co-operative bank is permanently a bit worse, which
    // is a different fact from being down, and the detector must not report the former.
    const failureBps =
      episode === null
        ? Math.round((BASELINE_FAILURE_BPS * 10_000) / issuer.multiplier_bps)
        : episode.failure_bps;

    const failed = rng.chance(bps(failureBps));

    stream.push({
      issuerId: issuer.id,
      rail,
      binBucket,
      succeeded: !failed,
      reasonCode: !failed
        ? null
        : episode === null
          ? rng.weighted(BACKGROUND_CAUSES)
          : episode.dominant_code,
      // Realistic ticket sizes. Amount plays no part in detection; it is here because the
      // table records what was attempted and a zero would be refused by a CHECK.
      amountPaise: BigInt(rng.nextInt(29_900, 899_900)),
      occurredAt,
    });
  }

  return stream;
}

/**
 * The episodes a detector is expected to find, in the shape the scorer wants.
 *
 * Only the material ones. The immaterial episode is deliberately excluded: missing it must
 * cost nothing, and reporting it must cost precision — which is exactly what happens when it
 * is absent from this list, since the scorer counts any signal matching no known episode as
 * a false positive.
 */
export function materialOutages(
  outages: readonly Outage[],
  epoch: Date,
): readonly { issuerId: string; rail: Rail; start: Date; end: Date }[] {
  return outages
    .filter((outage) => outage.material)
    .map((outage) => ({
      issuerId: outage.issuer_id,
      rail: outage.rail,
      start: new Date(epoch.getTime() + outage.start_offset_minutes * 60_000),
      end: new Date(
        epoch.getTime() +
          (outage.start_offset_minutes + outage.duration_minutes) * 60_000,
      ),
    }));
}
