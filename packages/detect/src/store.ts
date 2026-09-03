import { REASON_CODES, type Rail, type ReasonCode } from '@rc/core';
import type { Db } from '@rc/db';
import type { AuthObservation, DegradationSignal } from './detect.js';
import { forbidsCharge, permitsRailSwitch, type DegradationVerdict } from './detect.js';

/**
 * The detector's I/O, kept out of `detect.ts` so the judgement stays pure and testable.
 */

/**
 * Load the merchant's authorisation stream for a batch.
 *
 * The reason code is joined from the classification where one exists. It is the CLASSIFIED
 * code rather than the raw gateway string, because "which cause do these failures
 * concentrate on" is the root-cause step and a gateway's own code vocabulary differs by
 * acquirer — grouping on raw strings would split one cause across three spellings and find
 * no concentration at all.
 *
 * Successes carry no reason code and must not be dropped: they are the denominator.
 */
export async function loadAuthStream(
  db: Db,
  batchId: string,
): Promise<readonly AuthObservation[]> {
  const rows = await db
    .selectFrom('auth_attempt')
    .leftJoin('classification', 'classification.txn_id', 'auth_attempt.txn_id')
    .select([
      'auth_attempt.issuer_id as issuerId',
      'auth_attempt.rail as rail',
      'auth_attempt.bin_bucket as binBucket',
      'auth_attempt.succeeded as succeeded',
      'auth_attempt.occurred_at as occurredAt',
      'auth_attempt.gateway_code as gatewayCode',
      'classification.reason_code as classifiedCode',
    ])
    .where('auth_attempt.batch_id', '=', batchId)
    .orderBy('auth_attempt.occurred_at', 'asc')
    .execute();

  return rows.map((row) => ({
    issuerId: row.issuerId,
    rail: row.rail,
    binBucket: row.binBucket,
    succeeded: row.succeeded,
    reasonCode: causeOf(row.classifiedCode, row.gatewayCode),
    occurredAt: row.occurredAt,
  }));
}

/**
 * The cause of one failure: the classification where there is one, the gateway's own code
 * otherwise.
 *
 * THE FALLBACK IS THE WHOLE POINT, and leaving it out was a bug that silently disabled the
 * root-cause step. Only the failures the merchant opened a recovery case on are classified —
 * a few hundred out of fourteen thousand — so joining to `classification` alone returned a
 * null cause for essentially the entire stream. Every signal then carried
 * `dominantCode: null`, and a fraud-rule concentration was reported as an issuer outage.
 *
 * That is not a cosmetic loss. The verdicts differ precisely in their response: an outage
 * says re-present on another rail, a fraud rule says stop presenting. Reading the wrong one
 * means switching rails to get around a risk engine, which is futile and is how a merchant's
 * acquirer relationship gets reviewed. The detector was finding the right cohorts and
 * prescribing the wrong cure.
 *
 * Membership is checked rather than cast. A real gateway's vocabulary is its own — `05`,
 * `DO_NOT_HONOUR`, `insufficient_balance` — and admitting an unrecognised string would let
 * an acquirer's spelling become a taxonomy code, splitting one cause across three names so
 * that no concentration is ever found.
 */
function causeOf(classified: string | null, gatewayCode: string | null): ReasonCode | null {
  const candidate = classified ?? gatewayCode;
  if (candidate === null) return null;
  return (REASON_CODES as readonly string[]).includes(candidate)
    ? (candidate as ReasonCode)
    : null;
}

/**
 * Persist what the detector concluded.
 *
 * Written before any decision consults it, so the audit trail contains the evidence in the
 * order it was actually used: a signal cannot appear to have justified a decision it was
 * recorded after.
 */
export async function recordSignals(
  db: Db,
  batchId: string,
  signals: readonly DegradationSignal[],
): Promise<void> {
  if (signals.length === 0) return;

  await db
    .insertInto('degradation_signal')
    .values(
      signals.map((signal) => ({
        batch_id: batchId,
        issuer_id: signal.issuerId,
        rail: signal.rail,
        bin_bucket: signal.binBucket,
        window_start: signal.windowStart,
        window_end: signal.windowEnd,
        first_seen_at: signal.firstSeenAt,
        attempts: signal.attempts,
        failures: signal.failures,
        observed_bps: signal.observedBps,
        baseline_bps: signal.baselineBps,
        lower_bound_bps: signal.lowerBoundBps,
        dominant_code: signal.dominantCode,
        verdict: signal.verdict,
      })),
    )
    .execute();
}

export async function loadSignals(
  db: Db,
  batchId: string,
): Promise<readonly DegradationSignal[]> {
  const rows = await db
    .selectFrom('degradation_signal')
    .selectAll()
    .where('batch_id', '=', batchId)
    .orderBy('window_start', 'asc')
    .execute();

  return rows.map((row) => ({
    issuerId: row.issuer_id,
    rail: row.rail,
    binBucket: row.bin_bucket,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    firstSeenAt: row.first_seen_at,
    attempts: row.attempts,
    failures: row.failures,
    observedBps: row.observed_bps,
    baselineBps: row.baseline_bps,
    lowerBoundBps: row.lower_bound_bps,
    dominantCode: (row.dominant_code as ReasonCode | null) ?? null,
    verdict: row.verdict,
  }));
}

/**
 * What the engine needs to know about one transaction's cohort, at one moment.
 *
 * Deliberately not the signal itself. The engine's question is not "what did the detector
 * find" but "may I charge this rail right now, and if not may I go elsewhere" — and keeping
 * the interface at that level means a change to how detection works cannot change what the
 * policy is allowed to conclude from it.
 */
export interface CohortRisk {
  readonly degraded: boolean;
  /** True when the charge must not be re-presented on this rail. */
  readonly chargeForbidden: boolean;
  /** True when another rail is a legitimate response. False for a fraud rule, which
   *  travels with the card rather than the rail. */
  readonly railSwitchPermitted: boolean;
  readonly verdict: DegradationVerdict | null;
  readonly dominantCode: ReasonCode | null;
}

export const NO_COHORT_RISK: CohortRisk = {
  degraded: false,
  chargeForbidden: false,
  railSwitchPermitted: false,
  verdict: null,
  dominantCode: null,
};

/**
 * The signal in force for a cohort at an instant, if any.
 *
 * TIME-BOUNDED ON PURPOSE. A detection is a statement about a window, not a permanent mark
 * against an issuer. An outage that ended at 14:30 must stop suppressing charges at 14:30,
 * or the first real degradation the system ever sees would disable that issuer for the rest
 * of the batch and the recovery book would quietly shrink for the wrong reason.
 *
 * When several overlap, the one that forbids the most wins: a fraud rule inside an outage
 * means stop, not switch.
 */
export function signalsAffecting(
  signals: readonly DegradationSignal[],
  cohort: { readonly issuerId: string | null; readonly rail: Rail; readonly at: Date },
): CohortRisk {
  if (cohort.issuerId === null) return NO_COHORT_RISK;

  const at = cohort.at.getTime();
  const live = signals.filter(
    (signal) =>
      signal.issuerId === cohort.issuerId &&
      signal.rail === cohort.rail &&
      signal.windowStart.getTime() <= at &&
      at < signal.windowEnd.getTime(),
  );

  // Precedence: a fraud rule is the most restrictive finding, so it decides. Resolved with
  // a single `find` over both, rather than a length check and an index, so the empty case
  // cannot be asserted away — the rule that bans `!` here is the same one that caught a
  // reduce seeded with `arms[0]!` reporting the controller's own net as the bar it beat.
  const chosen = live.find((signal) => signal.verdict === 'fraud_rule') ?? live.at(0);
  if (chosen === undefined) return NO_COHORT_RISK;

  return {
    degraded: true,
    chargeForbidden: forbidsCharge(chosen.verdict),
    railSwitchPermitted: permitsRailSwitch(chosen.verdict),
    verdict: chosen.verdict,
    dominantCode: chosen.dominantCode,
  };
}
