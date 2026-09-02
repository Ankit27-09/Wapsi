import { z } from 'zod';
import type { ReasonCode } from './taxonomy.js';

/**
 * RISK CLASSES
 *
 * "Revenue at risk" is broader than "a payment that failed". The brief names three domains —
 * payment failures, checkout abandonment, overdue receivables — and they are the same shape
 * of problem: an amount of money attached to a customer, with a cause, on which a bounded
 * and priced intervention may be attempted.
 *
 * So there is ONE engine and five classes, not five systems. Each class differs in exactly
 * three ways, and everything else is shared:
 *
 *   1. WHICH CAUSES it can have. An invoice cannot fail for insufficient funds; a card can.
 *   2. WHICH INTERVENTIONS are legal. An abandoned checkout cannot be retried — there is
 *      nothing to charge — so its only lever is a link.
 *   3. HOW VALUE AND COST ARE COMPUTED. A subscription cycle is worth its remaining
 *      lifetime, not one cycle. A checkout nudge costs a message and no gateway fee.
 *
 * The expected-value gate already takes fee and message cost as separate inputs and
 * multiplies by a value term, so all three differences are data rather than code paths.
 */

export const RISK_CLASSES = [
  'payment_failure',
  'subscription_failure',
  'mandate_lapsed',
  'checkout_abandonment',
  'receivable_overdue',
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];
export const RiskClassSchema = z.enum(RISK_CLASSES);

/**
 * Interventions.
 *
 * Only `retry` and `switch_rail` present a charge, which is why they are the only two that
 * incur a gateway fee — a distinction the database enforces as well, so a `payment_link`
 * cannot acquire a rail by accident.
 */
export const INTERVENTIONS = [
  'retry',
  'switch_rail',
  'notify',
  'escalate',
  'none',
  'payment_link',
  'remandate',
  'pre_debit_notify',
  /** Recorded when an open promise-to-pay suppresses the ladder. Deliberate inaction. */
  'await_promise',
] as const;

// There is deliberately no `voice_call` intervention. A call is a `notify` whose template
// happens to be registered on the `voice` channel — the template carries the channel, so a
// separate action would be a second source of truth for the same fact, and the two would
// eventually disagree about what was actually sent.

export type Intervention = (typeof INTERVENTIONS)[number];
export const InterventionSchema = z.enum(INTERVENTIONS);

/** Interventions that present a charge and therefore incur a gateway fee. */
const CHARGING: ReadonlySet<Intervention> = new Set(['retry', 'switch_rail']);

export function incursGatewayFee(intervention: Intervention): boolean {
  return CHARGING.has(intervention);
}

export interface RiskClassMeta {
  readonly label: string;
  /** Causes this class can have. A cause outside this set is a data error, not a rare case. */
  readonly causes: readonly ReasonCode[];
  /** Interventions legal for this class. Anything else is refused before it is priced. */
  readonly interventions: readonly Intervention[];
  /**
   * Whether recovering one instance saves a recurring stream.
   *
   * True means the value term multiplies by remaining cycles: losing a subscription cycle
   * usually means losing the subscriber, so pricing the retry at one cycle's margin
   * systematically under-invests in the customers worth most.
   */
  readonly recurring: boolean;
  readonly note: string;
}

export const RISK_CLASS_META: Readonly<Record<RiskClass, RiskClassMeta>> = {
  payment_failure: {
    label: 'One-off payment failure',
    causes: [
      'insufficient_funds',
      'issuer_down',
      'do_not_honour',
      'threeds_timeout',
      'card_expired',
      'network_timeout',
      'suspected_fraud_block',
      'unknown',
    ],
    interventions: ['retry', 'switch_rail', 'notify', 'escalate', 'payment_link', 'none'],
    recurring: false,
    note:
      'A single payment that failed. Timing and rail are the levers, and the instrument is ' +
      'usually still valid — which is what separates it from a lapsed mandate.',
  },

  subscription_failure: {
    label: 'Recurring cycle failure',
    causes: ['insufficient_funds', 'issuer_down', 'do_not_honour', 'card_expired', 'network_timeout', 'unknown'],
    // `pre_debit_notify` belongs here and nowhere else among the charging classes: this is
    // the only class with a LIVE mandate, and a live mandate is what a pre-debit
    // notification is about. A lapsed one has no debit to notify of.
    interventions: [
      'retry',
      'switch_rail',
      'notify',
      'escalate',
      'remandate',
      'pre_debit_notify',
      'none',
    ],
    recurring: true,
    note:
      'A billing cycle that failed on a live subscription. Economically distinct from a ' +
      'one-off: the downside is not this cycle but the whole remaining relationship, so the ' +
      'same probability justifies far more spend.',
  },

  mandate_lapsed: {
    label: 'Authorisation lapsed or expiring',
    causes: ['mandate_expired', 'unknown'],
    // Deliberately no `retry`. There is no live authorisation to debit, so a retry is not
    // unlikely to work — it is impossible. The sequence is notify, then re-authorise.
    interventions: ['remandate', 'notify', 'escalate', 'none'],
    recurring: true,
    note:
      'The authorisation itself is gone or about to be. No retry can succeed; the only path ' +
      'is getting the customer to re-authorise, and under RBI e-mandate rules a debit must ' +
      'be preceded by a pre-debit notification.',
  },

  checkout_abandonment: {
    label: 'Checkout abandoned',
    causes: [
      'abandoned_at_cart',
      'abandoned_at_address',
      'abandoned_at_payment',
      'abandoned_at_otp',
      'unknown',
    ],
    // No `retry` and no `switch_rail`: nothing was ever charged, so there is nothing to
    // re-present. The only lever is getting the customer back to a payable page.
    interventions: ['payment_link', 'notify', 'escalate', 'none'],
    recurring: false,
    note:
      'The customer left before paying. Nothing was charged, so there is no gateway fee and ' +
      'no instrument to retry — the entire cost is the message. How far they got is the ' +
      'strongest signal: someone who reached the OTP screen was ready to pay.',
  },

  receivable_overdue: {
    label: 'Invoice overdue',
    causes: [
      'awaiting_approval',
      'disputed_line_item',
      'payment_run_cycle',
      'no_response',
      'promised_not_paid',
      'unknown',
    ],
    interventions: ['notify', 'payment_link', 'escalate', 'await_promise', 'none'],
    recurring: false,
    note:
      'A B2B invoice past its due date. Driven by days overdue rather than attempt count, ' +
      'and by cause: an invoice waiting on an approver needs a different nudge from one ' +
      'stuck behind a monthly payment run, and a disputed one needs a human immediately.',
  },
};

/** Whether a cause is valid for a risk class. */
export function causeIsValidFor(riskClass: RiskClass, cause: ReasonCode): boolean {
  return RISK_CLASS_META[riskClass].causes.includes(cause);
}

/** Whether an intervention is permitted for a risk class. */
export function interventionIsValidFor(
  riskClass: RiskClass,
  intervention: Intervention,
): boolean {
  return RISK_CLASS_META[riskClass].interventions.includes(intervention);
}
