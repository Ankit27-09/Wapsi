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
  // --- payment and subscription failures -----------------------------------
  'insufficient_funds',
  'issuer_down',
  'do_not_honour',
  'threeds_timeout',
  'card_expired',
  'network_timeout',
  'mandate_expired',
  'suspected_fraud_block',

  // --- checkout abandonment -------------------------------------------------
  // The stage reached is the whole signal. Someone who left at the cart was browsing;
  // someone who left at the OTP screen had their card out and intended to pay. Treating
  // those as one cause would average away the only useful information available.
  'abandoned_at_cart',
  'abandoned_at_address',
  'abandoned_at_payment',
  'abandoned_at_otp',

  // --- overdue receivables --------------------------------------------------
  // B2B non-payment is almost never inability to pay. It is a process problem, and which
  // process determines who to contact and whether to contact them at all.
  'awaiting_approval',
  'disputed_line_item',
  'payment_run_cycle',
  'no_response',
  'promised_not_paid',

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
  // --- checkout abandonment -------------------------------------------------
  // `terminal: true` for all four, and it is not a technicality: nothing was ever charged,
  // so there is no instrument to re-present. "Terminal" means no RETRY can succeed — it says
  // nothing about whether the money is recoverable, and a payment link recovers a great deal
  // of it. Keeping "cannot be retried" separate from "cannot be recovered" is exactly what a
  // class-aware taxonomy has to get right.

  abandoned_at_cart: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Left with items in the cart, before entering any details. The weakest intent signal ' +
      'in the funnel — much of this is browsing — so a nudge has to clear a low bar to be ' +
      'worth its message cost.',
  },
  abandoned_at_address: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Entered an address then stopped. Intent is real but something interrupted, often a ' +
      'delivery charge or timeline revealed at this step.',
  },
  abandoned_at_payment: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Reached payment selection and left without choosing. Strong intent, and frequently a ' +
      'missing preferred method rather than a change of mind.',
  },
  abandoned_at_otp: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Reached authentication and did not complete it. The strongest intent signal in the ' +
      'funnel: the card was entered and the customer meant to pay. Usually an OTP that never ' +
      'arrived or an expired session, which a fresh link fixes outright.',
  },

  // --- overdue receivables --------------------------------------------------
  // B2B non-payment is rarely inability to pay. It is a process problem, and which process
  // decides who to contact and whether to contact anyone at all.

  awaiting_approval: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Inside the buyer’s approval chain. Nobody is refusing and nothing is wrong — chasing ' +
      'the original contact achieves nothing because they are not the blocker. The useful ' +
      'action is reaching the approver.',
  },
  disputed_line_item: {
    terminal: true,
    notifiable: false,
    neverContact: false,
    note:
      'The buyer disagrees with something on the invoice. Automated chasing makes this ' +
      'strictly worse — it applies pressure over an amount genuinely in question and damages ' +
      'the relationship. Escalate to a human immediately.',
  },
  payment_run_cycle: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'The buyer pays on a fixed cycle and this invoice missed it. Highly recoverable and ' +
      'purely a timing problem: one reminder landing two days before the next run beats ' +
      'three sent at random.',
  },
  no_response: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'Overdue with no reply to anything. The genuine collections case, and where an ' +
      'escalating ladder plus a hard stopping rule matters most.',
  },
  promised_not_paid: {
    terminal: true,
    notifiable: true,
    neverContact: false,
    note:
      'A promise-to-pay date passed without payment. A strong negative signal: it lowers the ' +
      'weight of this buyer’s future promises and justifies escalating past automated ' +
      'reminders to a human.',
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

/**
 * Regulated messaging channels. Every one requires template registration and consent.
 *
 * `voice` is not "SMS with audio". In India it sits under a separate consent regime — the
 * NCPR/DND registry, its own permitted calling window, its own daily limits — and costs
 * roughly twenty times as much. Modelling it as a channel rather than a special case is what
 * lets the expected-value gate decide between a cheap message and an expensive call.
 */
export const CHANNELS = ['sms', 'whatsapp', 'email', 'voice'] as const;
export type Channel = (typeof CHANNELS)[number];
export const ChannelSchema = z.enum(CHANNELS);

export function isTerminal(code: ReasonCode): boolean {
  return REASON_CODE_META[code].terminal;
}

/**
 * An ABSOLUTE bar on contacting the customer about this cause.
 *
 * Compliance, not judgement. A risk-flagged transaction is not a marketing opportunity and
 * an unidentified cause is not something to write to a customer about, so nothing overrides
 * this — not a legally required notice, not an operator, not the expected value.
 */
export function isNeverContact(code: ReasonCode): boolean {
  return REASON_CODE_META[code].neverContact;
}

/**
 * Whether a NUDGE about this cause is worth sending.
 *
 * A judgement about usefulness, not a compliance bar, and the distinction turned out to
 * matter. `issuer_down`, `do_not_honour` and `network_timeout` are all `notifiable: false`
 * for a good reason: nothing the customer does affects an issuer outage, so telling them
 * about it is noise.
 *
 * But that reasoning is about a message DESCRIBING THE FAILURE. It says nothing about a
 * pre-debit notification, which is not a nudge at all — it is the notice that makes an
 * e-mandate debit lawful, and whether the customer can act on the underlying failure is
 * beside the point. Using one flag for both questions meant 29 legally required notices per
 * batch were refused as pointless, and every subscription behind them became unrecoverable:
 * no notice, therefore no lawful debit, therefore nothing.
 *
 * So the two questions are now asked separately, and `checkContactBounds` takes a
 * `mandatoryNotice` flag that overrides this one but never overrides `isNeverContact`.
 */
export function isNotifiable(code: ReasonCode): boolean {
  return REASON_CODE_META[code].notifiable;
}

/**
 * Whether an ordinary recovery nudge about this cause may be sent.
 *
 * Both conditions, which is the common case. A mandatory notice is the exception and goes
 * through `checkContactBounds` with its own flag rather than through here.
 */
export function mayEverContact(code: ReasonCode): boolean {
  const meta = REASON_CODE_META[code];
  return meta.notifiable && !meta.neverContact;
}
