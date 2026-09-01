import {
  isWithinLocalWindow,
  mayEverContact,
  type Channel,
  type Paise,
  type ReasonCode,
} from '@rc/core';
import type { Policy } from './policy.js';

/**
 * BOUNDS CHECKING
 *
 * The rules that make this system incapable of acting outside its authorisation, rather
 * than merely unlikely to. Pure functions: no clock of their own, no database, no policy
 * mutation. The caller supplies `now` and the observed history, which is what makes every
 * rule below exhaustively property-testable.
 *
 * Split into two functions rather than one, and the split is the design:
 *
 *   `checkAttemptBounds` — may this attempt happen at all?
 *   `checkContactBounds` — may this customer be messaged right now?
 *
 * They are separate because the answers legitimately differ. A retry at 03:00 is fine;
 * the SMS about it is not. Collapsing them into one verdict would mean quiet hours
 * silently costing recoveries — the system would decline a perfectly good retry because
 * it could not send an optional nudge alongside it. Keeping them apart lets the engine
 * retry silently and audit the suppressed contact as its own event.
 *
 * It also means escalation, which is a contact with no attempt, reuses the second
 * function without pretending to be an attempt.
 */

export type AttemptBound =
  | 'kill_switch'
  | 'terminal'
  | 'attempt_cap'
  | 'min_gap'
  | 'batch_fee_budget';

export type ContactBound =
  | 'kill_switch'
  | 'never_contact'
  | 'no_template'
  | 'consent'
  | 'quiet_hours'
  | 'contact_ceiling';

export type ConsentState = 'opt_in' | 'opt_out' | 'unknown';

export interface AttemptBoundsInput {
  readonly now: Date;
  readonly policy: Policy;
  readonly reasonCode: ReasonCode;
  /** 1-indexed attempt being considered. */
  readonly attemptNo: number;
  /** Null when this is the first attempt. */
  readonly hoursSinceLastAttempt: number | null;
  /** Fee budget left in this batch, already net of everything spent. */
  readonly batchFeeRemaining: Paise;
  /** Gateway fee this attempt would incur. */
  readonly gatewayFee: Paise;
}

export interface ContactBoundsInput {
  readonly now: Date;
  readonly policy: Policy;
  readonly reasonCode: ReasonCode;
  readonly channel: Channel;
  readonly consent: ConsentState;
  /** Messages already sent to this customer inside the rolling week. */
  readonly contactsThisWeek: number;
  /** Whether a registered template exists for this send. */
  readonly hasRegisteredTemplate: boolean;
}

export type BoundsVerdict<Rule extends string> =
  | { readonly kind: 'allow' }
  | { readonly kind: 'block'; readonly rule: Rule; readonly detail: string };

const allow = <R extends string>(): BoundsVerdict<R> => ({ kind: 'allow' });
const block = <R extends string>(rule: R, detail: string): BoundsVerdict<R> => ({
  kind: 'block',
  rule,
  detail,
});

/**
 * May this attempt happen at all?
 *
 * Checks run cheapest-and-most-absolute first, so the reported reason is the most
 * fundamental one. When the kill switch is on, that is the answer — not "attempt cap
 * reached", which would be true but would send an operator looking in the wrong place.
 */
export function checkAttemptBounds(
  input: AttemptBoundsInput,
): BoundsVerdict<AttemptBound> {
  const { policy, reasonCode, attemptNo } = input;

  if (policy.killSwitch) {
    return block('kill_switch', 'Global kill switch is engaged; no action may fire.');
  }

  const cap = policy.attemptCap(reasonCode);

  if (cap === 0) {
    // Not "unlikely to work" — structurally impossible. An expired card or a revoked
    // mandate has nothing to debit, so an attempt here would spend a fee against a
    // probability of exactly zero.
    return block(
      'terminal',
      `${reasonCode} permits no attempts: ${policy.forReason(reasonCode).note ?? 'retrying cannot succeed'}`,
    );
  }

  if (attemptNo > cap) {
    return block(
      'attempt_cap',
      `Attempt ${attemptNo} exceeds the schedule for ${reasonCode}, which permits ${cap}.`,
    );
  }

  const minGap = policy.forReason(reasonCode).min_gap_hours;
  if (
    input.hoursSinceLastAttempt !== null &&
    minGap > 0 &&
    input.hoursSinceLastAttempt < minGap
  ) {
    return block(
      'min_gap',
      `Only ${input.hoursSinceLastAttempt.toFixed(1)}h since the last attempt; ` +
        `${reasonCode} requires ${minGap}h so the retry lands in a different world than the failure.`,
    );
  }

  // Strictly greater-than: an attempt that would exactly exhaust the budget is permitted.
  // The database CHECK constraint enforces the same boundary, so a code path that skipped
  // this would abort the transaction rather than overspend.
  if (input.gatewayFee > input.batchFeeRemaining) {
    return block(
      'batch_fee_budget',
      'Batch fee budget is exhausted; further attempts would spend past the ceiling.',
    );
  }

  return allow();
}

/**
 * May this customer be contacted right now?
 *
 * Consent and the failure class are checked separately and both must permit the send.
 * They answer different questions — consent is a property of the person, `never_contact`
 * is a property of the failure — and one function answering both is how a risk-flagged
 * customer eventually gets messaged because somebody updated the wrong branch.
 */
export function checkContactBounds(
  input: ContactBoundsInput,
): BoundsVerdict<ContactBound> {
  const { policy, reasonCode, channel } = input;

  if (policy.killSwitch) {
    return block('kill_switch', 'Global kill switch is engaged; no message may be sent.');
  }

  if (!mayEverContact(reasonCode)) {
    return block(
      'never_contact',
      `${reasonCode} must never trigger a customer contact. Messaging a customer whose ` +
        `transaction was risk-flagged, or whose cause is unidentified, is a compliance ` +
        `incident rather than a suboptimal decision.`,
    );
  }

  if (!input.hasRegisteredTemplate) {
    // Not a nicety. Commercial SMS in India requires a DLT-registered template and
    // WhatsApp business messaging requires a pre-approved one, so a send with no
    // registered template is unshippable rather than merely unpolished.
    return block(
      'no_template',
      `No registered template for ${reasonCode} on ${channel}; free-form text cannot be ` +
        `sent on a regulated channel.`,
    );
  }

  if (policy.consentRequiredChannels.includes(channel) && input.consent !== 'opt_in') {
    return block(
      'consent',
      `Consent for ${channel} is "${input.consent}"; an explicit opt-in is required.`,
    );
  }

  if (isWithinLocalWindow(input.now, policy.quietHours)) {
    return block(
      'quiet_hours',
      `Inside quiet hours (${policy.quietHours.start}–${policy.quietHours.end} ` +
        `${policy.quietHours.tz}). The attempt itself may still proceed silently.`,
    );
  }

  if (input.contactsThisWeek >= policy.maxContactsPerWeek) {
    return block(
      'contact_ceiling',
      `Customer has already received ${input.contactsThisWeek} message(s) this week; ` +
        `the ceiling is ${policy.maxContactsPerWeek}.`,
    );
  }

  return allow();
}
