import {
  DEGRADATION_VERDICTS,
  Z_99,
  toBps,
  wilsonLowerBound,
  type DegradationVerdict,
  type Rail,
  type ReasonCode,
} from '@rc/core';

/**
 * Degradation detection: finding a cohort going bad before any transaction inside it looks
 * unusual on its own.
 *
 * THE THING A PER-TRANSACTION VIEW CANNOT SEE. A declined card is an event, and every
 * declined card looks like every other declined card. "Authorisation success on ISS_COOP
 * cards fell to 34% over the last forty minutes" is not visible in any one of them — it is a
 * property of a population over time. That is what the brief's first example direction asks
 * for, and it changes the correct recovery action rather than merely annotating it: a retry
 * on a rail that is currently down is a fee paid into a system that cannot answer.
 *
 * WHAT IT COMPARES AGAINST, which is the whole design.
 *
 * The naive version compares a cohort's failure rate to a configured constant. That is wrong
 * in both directions at once. Failure rates move with the hour of the day, with the mix of
 * amounts, and with which customers happen to be transacting — so a fixed threshold alerts
 * every evening and misses a real outage that starts from an already-quiet baseline.
 *
 * So the baseline is CONTEMPORANEOUS AND PEER-DERIVED: a cohort is compared to the other
 * cohorts on the same rail in the same window. If one issuer is failing at 60% while its
 * peers sit at 9%, that is specific and actionable. If every issuer on the rail is failing at
 * 60%, the issuer is not the problem — the rail, the acquirer or our own integration is, and
 * that is a different verdict with a different response. Comparing against peers gets both
 * cases right for free, and controls for time of day without modelling it.
 *
 * WHY IT DOES NOT FIRE ON NOISE. Two independent guards, for two different reasons:
 *
 *   - The Wilson lower bound, not the observed rate, must clear the baseline. This is
 *     STATISTICAL: at n=3 the interval is so wide that three failures out of three cannot
 *     clear a 9% baseline, while at n=300 a modest elevation can.
 *   - A minimum attempt count. This is OPERATIONAL, and it is not redundant. Eight
 *     consecutive failures IS statistically overwhelming (p ≈ 4e-9 against a 9% baseline),
 *     and acting on it is still usually wrong: watch twenty cohorts continuously and runs
 *     like that arrive constantly, while switching every customer off an issuer has a real
 *     cost. Significance and materiality are different questions and each needs its own
 *     answer.
 */

// The verdict vocabulary lives in @rc/core, because @rc/policy has to act on one and
// @rc/db has to store one, and neither may depend on this package to learn what they are.
export { DEGRADATION_VERDICTS, type DegradationVerdict };

/** One authorisation attempt from the merchant's stream. Successes included — they are the
 *  denominator, and without them there is no rate to compute. */
export interface AuthObservation {
  readonly issuerId: string;
  readonly rail: Rail;
  readonly binBucket: string | null;
  readonly succeeded: boolean;
  /** The taxonomy code this failure maps to, where one is known. Null on successes. */
  readonly reasonCode: ReasonCode | null;
  readonly occurredAt: Date;
}

export interface DetectorConfig {
  /** Width of the rolling window. Wide enough to accumulate a sample, narrow enough that a
   *  finished outage stops being reported as a current one. */
  readonly windowMinutes: number;
  /** How far the window advances each step. Smaller means faster detection and more work. */
  readonly stepMinutes: number;
  /** Materiality floor, per cohort per window. See the note on the two guards above. */
  readonly minAttempts: number;
  /** Peer attempts required before a peer rate is usable as a baseline. Without this, one
   *  cohort on a quiet rail is compared against a baseline computed from four attempts. */
  readonly minPeerAttempts: number;
  /** Normal quantile for the Wilson bound. */
  readonly z: number;
  /** The cohort's lower bound must exceed the peer baseline by at least this, in basis
   *  points, before it counts. Statistical significance alone will flag a 3-point gap on a
   *  large sample, which is real and not worth switching anybody's rail over. */
  readonly minExcessBps: number;
  /** Share of a cohort's failures one reason code must hold to be called the cause. */
  readonly dominanceBps: number;
  /** Failure rate above which the whole rail is called degraded rather than one issuer. */
  readonly railDegradedBps: number;
}

/**
 * Defaults, chosen and justified rather than tuned until the demo looked good.
 *
 * 30-minute windows stepping 10: an issuer outage that matters lasts longer than half an
 * hour, and a 10-minute step means the worst-case detection delay is 10 minutes rather than
 * 30. 40 attempts because below that the Wilson bound cannot clear a realistic baseline by a
 * useful margin anyway, so a lower floor would only add cost. 99% rather than 95% because
 * the action is expensive and the cost of a miss is bounded — a missed outage degrades to
 * the per-transaction behaviour that existed before this package.
 */
export const DEFAULT_DETECTOR: DetectorConfig = {
  windowMinutes: 30,
  stepMinutes: 10,
  minAttempts: 40,
  minPeerAttempts: 60,
  z: Z_99,
  minExcessBps: 1500,
  dominanceBps: 6000,
  railDegradedBps: 3500,
};

export interface DegradationSignal {
  readonly issuerId: string;
  readonly rail: Rail;
  readonly binBucket: string | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  /**
   * When the detector could FIRST have concluded this — the close of the earliest window
   * that fired, preserved through coalescing.
   *
   * Separate from `windowEnd` because merging destroys it otherwise, and the two answer
   * different questions. `windowStart..windowEnd` is the period the degradation covers;
   * this is when we knew. A 90-minute outage merges into one signal ending at minute 120,
   * and reading the delay off that end would report a 90-minute detection lag for something
   * caught in 30 — the pessimistic direction, but still a fabricated number, and the field
   * an operator actually wants is "when did we know" rather than either.
   */
  readonly firstSeenAt: Date;
  readonly attempts: number;
  readonly failures: number;
  readonly observedBps: number;
  /** The peer rate this was judged against, not a configured constant. */
  readonly baselineBps: number;
  readonly lowerBoundBps: number;
  readonly dominantCode: ReasonCode | null;
  readonly verdict: DegradationVerdict;
}

/** A cohort key, flattened to a string for grouping. */
function cohortKey(issuerId: string, rail: Rail): string {
  return `${issuerId} ${rail}`;
}

interface Tally {
  attempts: number;
  failures: number;
  readonly byCode: Map<ReasonCode, number>;
  readonly bins: Map<string, number>;
}

function emptyTally(): Tally {
  return { attempts: 0, failures: 0, byCode: new Map(), bins: new Map() };
}

function tally(target: Tally, obs: AuthObservation): void {
  target.attempts += 1;
  if (obs.succeeded) return;

  target.failures += 1;
  if (obs.reasonCode !== null) {
    target.byCode.set(obs.reasonCode, (target.byCode.get(obs.reasonCode) ?? 0) + 1);
  }
  if (obs.binBucket !== null) {
    target.bins.set(obs.binBucket, (target.bins.get(obs.binBucket) ?? 0) + 1);
  }
}

/** The reason code holding at least `dominanceBps` of a cohort's failures, if any does. */
function dominantCode(t: Tally, dominanceBps: number): ReasonCode | null {
  let best: ReasonCode | null = null;
  let bestCount = 0;

  for (const [code, count] of t.byCode) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }

  if (best === null || t.failures === 0) return null;
  return toBps(bestCount / t.failures) >= dominanceBps ? best : null;
}

/** The BIN bucket concentrating the failures, when one does. Real degradations are often
 *  narrower than an issuer — one BIN range behind one acquirer — and naming it lets the
 *  response be narrower too. */
function dominantBin(t: Tally, dominanceBps: number): string | null {
  let best: string | null = null;
  let bestCount = 0;

  for (const [bin, count] of t.bins) {
    if (count > bestCount) {
      best = bin;
      bestCount = count;
    }
  }

  if (best === null || t.failures === 0) return null;
  return toBps(bestCount / t.failures) >= dominanceBps ? best : null;
}

/**
 * A candidate detection in one window, before contiguous windows are coalesced.
 */
interface Candidate extends Omit<DegradationSignal, 'windowStart' | 'windowEnd'> {
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

/**
 * Scan the stream and report the cohorts that degraded.
 *
 * Pure: same observations and config in, same signals out, no clock and no database. The
 * detector is the part whose judgement has to be defensible, so it is the part with no I/O.
 */
export function detect(
  observations: readonly AuthObservation[],
  config: DetectorConfig = DEFAULT_DETECTOR,
): readonly DegradationSignal[] {
  if (observations.length === 0) return [];
  if (config.stepMinutes <= 0 || config.windowMinutes <= 0) {
    throw new Error('window and step must be positive');
  }

  // Sorted once. The windowing below walks the stream in time order and a caller handing
  // over rows in insertion order would otherwise silently get empty windows.
  const stream = [...observations].sort(
    (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
  );

  // Destructured rather than indexed, so the empty case is handled by the type system. The
  // guard above already returned for an empty stream; this makes that fact checkable
  // instead of asserted.
  const [firstObs] = stream;
  const lastObs = stream.at(-1);
  if (firstObs === undefined || lastObs === undefined) return [];

  const first = firstObs.occurredAt.getTime();
  const last = lastObs.occurredAt.getTime();
  const windowMs = config.windowMinutes * 60_000;
  const stepMs = config.stepMinutes * 60_000;

  const candidates: Candidate[] = [];

  for (let start = first; start <= last; start += stepMs) {
    const end = start + windowMs;

    // Per-cohort tallies for this window, plus the per-rail totals the peer baseline needs.
    //
    // The cohort's identity is carried IN the entry rather than encoded in the map key and
    // split back out. Round-tripping an identifier through a delimited string loses the type
    // on the way out — `key.split(' ')` gives `(string | undefined)[]` and a cast back to
    // `Rail` — which is how a cohort key containing a space would have become a silently
    // mislabelled signal.
    const cohorts = new Map<string, { issuerId: string; rail: Rail; tally: Tally }>();
    const railTotals = new Map<Rail, Tally>();

    for (const obs of stream) {
      const at = obs.occurredAt.getTime();
      if (at < start) continue;
      if (at >= end) break;

      const key = cohortKey(obs.issuerId, obs.rail);
      let cohort = cohorts.get(key);
      if (cohort === undefined) {
        cohort = { issuerId: obs.issuerId, rail: obs.rail, tally: emptyTally() };
        cohorts.set(key, cohort);
      }
      tally(cohort.tally, obs);

      let rail = railTotals.get(obs.rail);
      if (rail === undefined) {
        rail = emptyTally();
        railTotals.set(obs.rail, rail);
      }
      tally(rail, obs);
    }

    for (const entry of cohorts.values()) {
      const { issuerId, rail } = entry;
      const cohort = entry.tally;
      if (cohort.attempts < config.minAttempts) continue;

      const railTotal = railTotals.get(rail);
      if (railTotal === undefined) continue;

      // THE PEER BASELINE: the same rail, the same window, every issuer EXCEPT this one.
      // Leaving the cohort in its own baseline is the mistake that makes a large cohort
      // undetectable — if ISS_NORTH is 60% of card volume, its own failures drag the
      // baseline up to meet it and it can never look anomalous.
      const peerAttempts = railTotal.attempts - cohort.attempts;
      const peerFailures = railTotal.failures - cohort.failures;

      const observedBps = toBps(cohort.failures / cohort.attempts);
      const lowerBoundBps = toBps(
        wilsonLowerBound(cohort.failures, cohort.attempts, config.z),
      );
      const code = dominantCode(cohort, config.dominanceBps);

      // A fraud rule is checked first because it inverts the response. An outage says
      // "re-present somewhere else"; a fraud rule says "stop presenting", and getting that
      // precedence backwards would have the system hammer a risk engine that is working
      // exactly as intended.
      if (code === 'suspected_fraud_block') {
        const railBps = toBps(railTotal.failures / railTotal.attempts);
        if (lowerBoundBps > railBps + config.minExcessBps) {
          candidates.push({
            issuerId,
            rail,
            binBucket: dominantBin(cohort, config.dominanceBps),
            windowStart: new Date(start),
            windowEnd: new Date(end),
            firstSeenAt: new Date(end),
            attempts: cohort.attempts,
            failures: cohort.failures,
            observedBps,
            baselineBps: railBps,
            lowerBoundBps,
            dominantCode: code,
            verdict: 'fraud_rule',
          });
          continue;
        }
      }

      // Not enough peer volume to say whether this cohort is unusual. Reported as a rail
      // problem below if the rail as a whole is bad, and otherwise not reported at all —
      // "we cannot tell" is a legitimate outcome and inventing a baseline is not.
      if (peerAttempts >= config.minPeerAttempts) {
        const baselineBps = toBps(peerFailures / peerAttempts);

        if (lowerBoundBps > baselineBps + config.minExcessBps) {
          candidates.push({
            issuerId,
            rail,
            binBucket: dominantBin(cohort, config.dominanceBps),
            windowStart: new Date(start),
            windowEnd: new Date(end),
            firstSeenAt: new Date(end),
            attempts: cohort.attempts,
            failures: cohort.failures,
            observedBps,
            baselineBps,
            lowerBoundBps,
            dominantCode: code,
            verdict: 'issuer_outage',
          });
          continue;
        }
      }

      // EVERY cohort on the rail is bad, so no cohort is anomalous relative to its peers
      // and the loop above found nothing. The rail itself is the finding — which is a real
      // and different situation, and one a peer comparison alone is structurally blind to.
      const railLowerBps = toBps(
        wilsonLowerBound(railTotal.failures, railTotal.attempts, config.z),
      );
      if (railLowerBps > config.railDegradedBps) {
        candidates.push({
          issuerId,
          rail,
          binBucket: null,
          windowStart: new Date(start),
          windowEnd: new Date(end),
            firstSeenAt: new Date(end),
          attempts: cohort.attempts,
          failures: cohort.failures,
          observedBps,
          baselineBps: config.railDegradedBps,
          lowerBoundBps,
          dominantCode: code,
          verdict: 'rail_degraded',
        });
      }
    }
  }

  return coalesce(candidates);
}

/**
 * Merge overlapping windows for the same cohort and verdict into one signal.
 *
 * WITHOUT THIS THE AUDIT TRAIL IS USELESS. A two-hour outage seen through 30-minute windows
 * stepping every 10 produces about a dozen signals for one event, and an operator reading
 * the trail cannot tell a dozen outages from one. Worse, a report counting signals would say
 * the detector found twelve degradations, which is a fabricated number.
 *
 * The merged signal keeps the widest window and the strongest evidence within it, so
 * coalescing cannot weaken what was claimed.
 */
function coalesce(candidates: readonly Candidate[]): readonly DegradationSignal[] {
  const groups = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const key = `${candidate.issuerId} ${candidate.rail} ${candidate.verdict}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const merged: DegradationSignal[] = [];

  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());

    let open: Candidate | null = null;

    for (const candidate of bucket) {
      if (open === null) {
        open = candidate;
        continue;
      }

      if (candidate.windowStart.getTime() <= open.windowEnd.getTime()) {
        // Overlapping: extend, and keep whichever window carried the most evidence.
        const stronger: Candidate = candidate.attempts > open.attempts ? candidate : open;
        open = {
          ...stronger,
          windowStart: open.windowStart,
          windowEnd: new Date(
            Math.max(open.windowEnd.getTime(), candidate.windowEnd.getTime()),
          ),
          firstSeenAt: new Date(
            Math.min(open.firstSeenAt.getTime(), candidate.firstSeenAt.getTime()),
          ),
        };
        continue;
      }

      merged.push(open);
      open = candidate;
    }

    if (open !== null) merged.push(open);
  }

  return merged.sort((a, b) => a.windowStart.getTime() - b.windowStart.getTime());
}

export { forbidsCharge, permitsRailSwitch } from '@rc/core';
