import { z } from 'zod';

/**
 * THE FAILURE TAXONOMY
 * ====================
 *
 * The organising rule: **a class exists only if it earns a distinct intervention.**
 *
 * This is the difference between a taxonomy and a list of error strings. Splitting
 * `issuer_declined_funds` from `issuer_declined_limit` buys nothing if both are handled
 * by "retry in the salary window". Merging `card_expired` into `insufficient_funds`
 * loses real money, because one needs a nudge for a new instrument and the other needs
 * a retry, and retrying an expired card succeeds exactly zero percent of the time
 * forever.
 *
 * `terminal` means: retrying the same instrument on the same rail has a structurally
 * zero success probability — not "low", not "usually fails", but zero by construction.
 * A terminal code must never consume a retry budget. Getting this distinction wrong is
 * the most expensive modelling error available on this problem.
 */

export const REASON_CODES = [
  'insufficient_funds',
  'issuer_down',
  'do_not_honour',
  'threeds_timeout',
  'card_expired',
  'network_timeout',
  'mandate_expired',
  'suspected_fraud_block',
  'unknown',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface ReasonCodeMeta {
  /** Retrying the same instrument/rail has a structurally zero success rate. */
  readonly terminal: boolean;
  /** Whether contacting the customer about this failure is ever appropriate. */
  readonly notifiable: boolean;
  /**
   * Compliance hard stop, independent of consent. A risk-flagged transaction is not a
   * marketing opportunity, and auto-contacting one is an incident rather than a
   * suboptimal decision.
   */
  readonly neverContact: boolean;
  /** What the code means in the real world, and why it is its own class. */
  readonly note: string;
}

export const REASON_CODE_META: Readonly<Record<ReasonCode, ReasonCodeMeta>> = {
  insufficient_funds: {
    terminal: false,
    notifiable: true,
    neverContact: false,
    note:
      'Issuer declined for want of balance. Timing is the entire lever — the same ' +
      'attempt has materially different odds before and after a salary credit, which ' +
      'is why this class exists separately from every other decline.',
  },
  issuer_down: {
    terminal: false,
    notifiable: false,
    neverContact: false,
    note:
      'Issuer-side outage or timeout cluster. Transient and self-healing, so short ' +
      'exponential backoff recovers it and contacting the customer is pure noise — ' +
      'nothing they can do affects the outcome.',
  },
  do_not_honour: {
    terminal: false,
    notifiable: false,
    neverContact: false,
    note:
      'The most common card decline in the world, and deliberately uninformative: the ' +
      'network permits the issuer to refuse without disclosing why. It could be funds, ' +
      'risk, a velocity rule, or a card control. Because the cause is unknowable, the ' +
      'expected-value gate rather than a retry schedule is the real control here — one ' +
      'cheap probe, then escalate.',
  },
  threeds_timeout: {
    terminal: false,
    notifiable: true,
    neverContact: false,
    note:
      'Authentication abandoned or the challenge expired. Distinct because the ' +
      'instrument is fine and the flow failed — the correct response is to change rail ' +
      '(UPI intent, netbanking), not to re-present the same 3DS challenge on the same ' +
      'bad network.',
  },
  card_expired: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Expiry date in the past. Terminal for the stored instrument: no amount of ' +
      'retrying changes it. The only intervention with non-zero value is asking the ' +
      'customer for a new instrument, which makes this a messaging problem wearing a ' +
      'retry problem’s clothes.',
  },
  network_timeout: {
    terminal: false,
    notifiable: false,
    neverContact: false,
    note:
      'Gateway or transport layer, not the issuer. The cheapest recovery in the ' +
      'taxonomy — one immediate retry, and if that fails the cause was not transport.',
  },
  mandate_expired: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'The recurring authorisation has lapsed or been revoked. Retry success is ' +
      'structurally zero forever, not merely unlikely: there is no live mandate to ' +
      'debit. Needs a re-authorisation flow, which is a human-facing escalation.',
  },
  suspected_fraud_block: {
    terminal: true,
    notifiable: false,
    neverContact: true,
    note:
      'Blocked by a risk engine. Never auto-retried and never auto-contacted. ' +
      'Messaging a customer whose transaction was risk-flagged is a compliance ' +
      'incident, and retrying past a risk decision is worse.',
  },
  unknown: {
    terminal: true,
    notifiable: false,
    neverContact: true,
    note:
      'The open-world bucket. Reached when the classifier’s calibrated confidence is ' +
      'below threshold, or the reason string is genuinely novel. No intervention fires ' +
      'on an unclassified root cause — the transaction is quarantined, clustered, and ' +
      'surfaced as a proposed new taxonomy entry for human approval. Guessing here ' +
      'would spend money on a cause nobody has identified.',
  },
};

export const ReasonCodeSchema = z.enum(REASON_CODES);

/** Rails a payment can be attempted on. Rail switching is an intervention in its own right. */
export const RAILS = ['card', 'upi_collect', 'upi_intent', 'netbanking', 'wallet'] as const;
export type Rail = (typeof RAILS)[number];
export const RailSchema = z.enum(RAILS);

/** Regulated messaging channels. Every one of these requires template registration and consent. */
export const CHANNELS = ['sms', 'whatsapp', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];
export const ChannelSchema = z.enum(CHANNELS);

export function isTerminal(code: ReasonCode): boolean {
  return REASON_CODE_META[code].terminal;
}

/**
 * Whether the customer may be contacted about this failure class at all.
 *
 * Deliberately separate from the consent check. This is a property of the *failure*,
 * consent is a property of the *customer*, and a send requires both to permit it. One
 * function answering both questions would be the kind of convenience that eventually
 * messages a fraud-flagged customer because someone updated the wrong branch.
 */
export function mayEverContact(code: ReasonCode): boolean {
  const meta = REASON_CODE_META[code];
  return meta.notifiable && !meta.neverContact;
}
