import { addHours, hoursBetween, type ReasonCode } from '@rc/core';
import type { Policy } from '@rc/policy';
import { TIMING_HOURS } from '@rc/simulator';

/**
 * WHEN AN ATTEMPT LANDS
 *
 * A timing bucket says how long after the FAILURE an attempt arrives — `salary_window` is
 * "48 to 96 hours after the payment failed", not "72 hours after the previous try". Both
 * runners originally advanced the clock cumulatively by the timing of the attempt just
 * fired, which is a different and wrong reading.
 *
 * THE BUG THAT CAUSED, because it was silent and expensive:
 *
 *   `insufficient_funds` attempt 1 is `immediate` (0.05h). Advancing cumulatively put the
 *   clock 3 minutes past the failure. Attempt 2 then needed a 48-hour gap, saw 0.05 hours,
 *   and was refused as `min_gap` — every time, for every transaction. The salary-window
 *   retry, which is the single intervention the whole strategy is built around, NEVER FIRED.
 *
 *   Nothing looked broken. The controller still beat every baseline, the refusals were
 *   audited with a correct-sounding reason, and 141 of them per batch were spurious. It
 *   surfaced only because the sensitivity sweep produced a perfectly flat curve — the
 *   salary-window probability could not matter, because nothing ever consulted it.
 *
 * Scheduling from the failure instant fixes it, and the sweep's flat line is what a
 * robustness check is for: it fails loudly when a parameter turns out to be unreachable.
 */

/** Minimum separation between consecutive attempts, so two never land on the same instant. */
const MIN_SEPARATION_HOURS = 1;

/**
 * When attempt `attemptNo` would land, measured from the failure.
 *
 * Uses the policy's schedule, which is exact for the Recovery Controller. The baseline arms
 * construct their plans directly and are not bounds-checked, so an approximation is
 * harmless for them — they progress on the fallback below.
 */
export function attemptLandsAt(args: {
  readonly policy: Policy;
  readonly reasonCode: ReasonCode;
  readonly attemptNo: number;
  readonly failedAt: Date;
  readonly previousLanding: Date | null;
  /** Where the clock is now, used when the policy schedules no such attempt. */
  readonly fallback: Date;
}): Date {
  const entry = args.policy.scheduleEntry(args.reasonCode, args.attemptNo);

  const scheduled =
    entry === undefined
      ? args.fallback
      : addHours(args.failedAt, TIMING_HOURS[entry.timing]);

  if (args.previousLanding === null) return scheduled;

  // Two attempts scheduled into the same bucket — `issuer_down` places attempts 2 and 3
  // both at `medium_backoff` — would otherwise land simultaneously.
  const earliest = addHours(args.previousLanding, MIN_SEPARATION_HOURS);
  return scheduled > earliest ? scheduled : earliest;
}

/**
 * Hours between the previous attempt's landing and this one's.
 *
 * Compared against the PROSPECTIVE landing rather than against the present moment, because
 * that is what a minimum gap means: how far apart the two attempts actually are, not how
 * long ago the last one was when the decision got made.
 */
export function gapSinceLastAttempt(
  previousLanding: Date | null,
  prospectiveLanding: Date,
): number | null {
  return previousLanding === null ? null : hoursBetween(previousLanding, prospectiveLanding);
}
