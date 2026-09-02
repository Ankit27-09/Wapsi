import {
  RISK_CLASS_META,
  incursGatewayFee,
  interventionIsValidFor,
  isNeverContact,
  isNotifiable,
  isWithinLocalWindow,
  type Channel,
  type Intervention,
  type Paise,
  type ReasonCode,
  type RiskClass,
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
  | 'batch_fee_budget'
  /** The intervention is not legal for this risk class — checked before it is priced. */
  | 'illegal_intervention'
  /** An e-mandate debit with no pre-debit notification on record 24h ahead. */
  | 'pre_debit_notice'
  /** An open promise-to-pay whose date has not yet arrived. */
  | 'promise_open';

export type ContactBound =
  | 'kill_switch'
  | 'never_contact'
  | 'no_template'
  | 'consent'
  | 'quiet_hours'
  | 'contact_ceiling'
  /** On the NCPR/DND registry. Blocks voice specifically, not messaging. */
  | 'ncpr_registry'
  /** Outside the narrower window permitted for outbound calls. */
  | 'voice_window'
  /** Weekly ceiling for calls, which is tighter than the one for messages. */
  | 'voice_ceiling';

export type ConsentState = 'opt_in' | 'opt_out' | 'unknown';

export interface AttemptBoundsInput {
  readonly now: Date;
  readonly policy: Policy;
  readonly reasonCode: ReasonCode;
  readonly riskClass: RiskClass;
  /** What this step would do. Checked against the risk class before it is priced. */
  readonly intervention: Intervention;
  /** 1-indexed attempt being considered. */
  readonly attemptNo: number;
  /** Null when this is the first attempt. */
  readonly hoursSinceLastAttempt: number | null;
  /** Fee budget left in this batch, already net of everything spent. */
  readonly batchFeeRemaining: Paise;
  /** Gateway fee this attempt would incur. */
  readonly gatewayFee: Paise;
  /**
   * Whether the transaction is debited under an e-mandate.
   *
   * True means a charge requires a pre-debit notification on record. Distinct from the risk
   * class: a live subscription is mandate-backed, a lapsed one has no mandate at all.
   */
  readonly mandateBacked: boolean;
  /** Hours since a pre-debit notification was sent, or null if none was. */
  readonly hoursSincePreDebitNotice: number | null;
  /**
   * A promise-to-pay date still in the future, if one is open.
   *
   * Chasing a buyer who has committed to a date before that date arrives is the fastest way
   * to lose the goodwill that produced the commitment, so the promise suppresses the ladder
   * until it either pays or breaks.
   */
  readonly openPromiseDueAt: Date | null;
}

export interface ContactBoundsInput {
  readonly now: Date;
  readonly policy: Policy;
  readonly reasonCode: ReasonCode;
  readonly channel: Channel;
  readonly consent: ConsentState;
  /** Messages already sent to this customer inside the rolling week. */
  readonly contactsThisWeek: number;
  /** Calls already placed to this customer inside the rolling week. */
  readonly callsThisWeek: number;
  /** Whether a registered template exists for this send. */
  readonly hasRegisteredTemplate: boolean;
  /**
   * Whether the number is on the NCPR / DND registry.
   *
   * Not the same thing as consent, and that is the point. Consent is an agreement with the
   * merchant; the registry is a standing instruction to the telecom regulator, and it
   * overrides merchant-level opt-in for promotional voice traffic. Treating them as one
   * field is how a system with a clean consent table still places an unlawful call.
   */
  readonly onNcprRegistry: boolean;
  /**
   * Whether this send is a legally required notice rather than a recovery nudge.
   *
   * True only for a pre-debit notification. Overrides the "a nudge here is noise" judgement
   * and nothing else — consent, quiet hours, the ceilings and the absolute never-contact bar
   * all still apply, because "required" describes why the message exists, not who may
   * receive it.
   */
  readonly mandatoryNotice: boolean;
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

  // Legality before economics, and before anything else that could be mistaken for it.
  // A retry on a lapsed mandate is not a bad bet — there is no authorisation to debit, so
  // the action does not exist. Reporting that as `refuse_ev` would suggest a better-priced
  // version of the same action might work, which is exactly the wrong conclusion.
  if (!interventionIsValidFor(input.riskClass, input.intervention)) {
    return block(
      'illegal_intervention',
      `${input.intervention} is not a legal intervention for ${input.riskClass}: ` +
        `${RISK_CLASS_META[input.riskClass].note}`,
    );
  }

  if (input.openPromiseDueAt !== null && input.openPromiseDueAt > input.now) {
    return block(
      'promise_open',
      `An open promise-to-pay falls due ${input.openPromiseDueAt.toISOString().slice(0, 10)}; ` +
        'the ladder is suppressed until it is kept or broken.',
    );
  }

  // An e-mandate debit is lawful only if the customer was notified in advance. The
  // notification is a prerequisite, not a courtesy, so a charge without one is refused
  // here rather than priced and fired.
  if (input.mandateBacked && incursGatewayFee(input.intervention)) {
    const notice = input.hoursSincePreDebitNotice;
    if (notice === null) {
      return block(
        'pre_debit_notice',
        'No pre-debit notification is on record. An e-mandate debit requires one at least ' +
          `${policy.preDebitNoticeHours}h in advance, so this charge cannot legally fire.`,
      );
    }
    if (notice < policy.preDebitNoticeHours) {
      return block(
        'pre_debit_notice',
        `The pre-debit notification was sent ${notice.toFixed(1)}h ago; ` +
          `${policy.preDebitNoticeHours}h must elapse before the debit may be presented.`,
      );
    }
  }

  const cap = policy.attemptCap(reasonCode, input.riskClass);

  if (cap === 0) {
    // Not "unlikely to work" — structurally impossible. An expired card or a revoked
    // mandate has nothing to debit, so an attempt here would spend a fee against a
    // probability of exactly zero.
    return block(
      'terminal',
      `${reasonCode} permits no attempts: ` +
        `${policy.forReason(reasonCode, input.riskClass).note ?? 'retrying cannot succeed'}`,
    );
  }

  if (attemptNo > cap) {
    return block(
      'attempt_cap',
      `Attempt ${attemptNo} exceeds the schedule for ${reasonCode}, which permits ${cap}.`,
    );
  }

  const minGap = policy.forReason(reasonCode, input.riskClass).min_gap_hours;
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

  // Two separate questions, and collapsing them cost real money.
  //
  // `isNeverContact` is compliance and nothing overrides it: a risk-flagged transaction is
  // not a marketing opportunity, and an unidentified cause is not something to write to a
  // customer about.
  //
  // `isNotifiable` is a judgement about whether a NUDGE is useful — false for an issuer
  // outage, because nothing the customer does affects it. That judgement must not block a
  // MANDATORY NOTICE. A pre-debit notification is not a nudge; it is the notice that makes
  // an e-mandate debit lawful, and the customer's ability to act on the underlying failure is
  // irrelevant to it. One flag answering both questions refused 29 required notices per
  // batch, and every subscription behind them became unrecoverable as a result.
  if (isNeverContact(reasonCode)) {
    return block(
      'never_contact',
      `${reasonCode} must never trigger a customer contact. Messaging a customer whose ` +
        `transaction was risk-flagged, or whose cause is unidentified, is a compliance ` +
        `incident rather than a suboptimal decision.`,
    );
  }

  if (!isNotifiable(reasonCode) && !input.mandatoryNotice) {
    return block(
      'never_contact',
      `A nudge about ${reasonCode} is noise — nothing the customer does affects the ` +
        `outcome. A legally mandated notice would still be permitted here; this is not one.`,
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

  // ---- voice-only rules ---------------------------------------------------
  // A call is not an SMS with audio. It sits under a separate regime, and the three rules
  // below are the reason `voice` is a channel in this system rather than a special case
  // bolted onto messaging: the expected-value gate can only choose between a cheap message
  // and an expensive call if the call's real constraints are priced alongside its cost.
  if (channel === 'voice') {
    if (input.onNcprRegistry) {
      return block(
        'ncpr_registry',
        'The number is on the NCPR/DND registry. That is a standing instruction to the ' +
          'regulator and it overrides merchant-level consent for outbound calls.',
      );
    }

    if (!isWithinLocalWindow(input.now, policy.voiceWindow)) {
      return block(
        'voice_window',
        `Outside the permitted calling window (${policy.voiceWindow.start}–` +
          `${policy.voiceWindow.end} ${policy.voiceWindow.tz}). Narrower than quiet hours ` +
          'on purpose: a call at 20:55 is an intrusion in a way a message is not.',
      );
    }

    if (input.callsThisWeek >= policy.maxCallsPerWeek) {
      return block(
        'voice_ceiling',
        `Customer has already received ${input.callsThisWeek} call(s) this week; the ` +
          `ceiling is ${policy.maxCallsPerWeek}, tighter than the ${policy.maxContactsPerWeek} ` +
          'permitted for messages.',
      );
    }
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
