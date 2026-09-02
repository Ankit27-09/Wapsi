import {
  addHours,
  deferIntoLocalWindow,
  deferPastLocalWindow,
  hoursBetween,
  type Channel,
  type ReasonCode,
  type RiskClass,
} from '@rc/core';
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
 * How long after a promised date the follow-up lands.
 *
 * Twelve hours, not twenty-four: a promise for "the 10th" is broken at the end of the 10th,
 * and calling on the morning of the 11th is the earliest moment that is unambiguous. Calling
 * on the 10th itself would chase a customer who is still keeping their word.
 */
const PROMISE_FOLLOWUP_HOURS = 12;

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
  readonly riskClass?: RiskClass;
  readonly attemptNo: number;
  readonly failedAt: Date;
  readonly previousLanding: Date | null;
  /** Where the clock is now, used when the policy schedules no such attempt. */
  readonly fallback: Date;
  /**
   * When a promise-to-pay falls due, if one was made.
   *
   * The `promise_followup` bucket is the only timing in the system measured from something
   * other than the failure, because the date it follows up on was chosen by the customer
   * rather than derived from anything the merchant did. Measuring it from the failure would
   * put the follow-up call before the promised date on any invoice more than two days old —
   * which is the precise behaviour a promise is supposed to prevent.
   */
  readonly promiseDueAt?: Date | null;
  /**
   * The channel this step's template sends on.
   *
   * Needed because voice has its own, much narrower permitted window. Defaults to `sms` when
   * the caller has not resolved a template — the deferral is then only out of quiet hours,
   * which is correct for every non-voice channel.
   */
  readonly channel?: Channel;
}): Date {
  const entry = args.policy.scheduleEntry(args.reasonCode, args.attemptNo, args.riskClass);

  const nominal =
    entry === undefined
      ? args.fallback
      : entry.timing === 'promise_followup' && args.promiseDueAt != null
        ? addHours(args.promiseDueAt, PROMISE_FOLLOWUP_HOURS)
        : addHours(args.failedAt, TIMING_HOURS[entry.timing]);

  const scheduled =
    entry === undefined
      ? nominal
      : deferForSendWindow(nominal, entry.action, args.policy, args.channel ?? 'sms');

  if (args.previousLanding === null) return scheduled;

  // Two attempts scheduled into the same bucket — `issuer_down` places attempts 2 and 3
  // both at `medium_backoff` — would otherwise land simultaneously.
  const earliest = addHours(args.previousLanding, MIN_SEPARATION_HOURS);
  return scheduled > earliest ? scheduled : earliest;
}

/**
 * Move a message-only step into a window where it may legally be sent.
 *
 * DEFERRED, NOT DROPPED, and the distinction was worth a large fraction of the recoverable
 * value in four of the five risk classes.
 *
 * A retry needs no deferral: quiet hours suppress its optional nudge and the charge proceeds
 * silently, which is the correct and already-implemented behaviour. But when the message IS
 * the intervention, cancelling it protects nobody — a payment link that would have arrived at
 * 03:00 was always going to be read after breakfast. Landings are spread across the clock and
 * quiet hours are half of it, so cancelling threw away roughly half of every messaging
 * schedule before it ever reached the expected-value gate.
 *
 * Voice gets both treatments in order: pushed out of quiet hours, then pulled into the much
 * narrower window in which calling is permitted at all.
 */
function deferForSendWindow(
  instant: Date,
  action: string,
  policy: Policy,
  channel: Channel,
): Date {
  if (!MESSAGE_IS_THE_ACTION.has(action)) return instant;

  const afterQuiet = deferPastLocalWindow(instant, policy.quietHours);
  return channel === 'voice' ? deferIntoLocalWindow(afterQuiet, policy.voiceWindow) : afterQuiet;
}

/** Actions whose entire mechanism is the message. Mirrors the set in `@rc/engine`. */
const MESSAGE_IS_THE_ACTION: ReadonlySet<string> = new Set([
  'payment_link',
  'notify',
  'pre_debit_notify',
  'remandate',
]);

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
