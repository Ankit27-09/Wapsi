import {
  RISK_CLASS_META,
  ZERO,
  assertNever,
  bps,
  incursGatewayFee,
  type Bps,
  type Channel,
  type Paise,
  type Rail,
  type ReasonCode,
  type RiskClass,
  type TemplateId,
} from '@rc/core';
import type { Verdict } from '@rc/db';
import {
  checkAttemptBounds,
  checkContactBounds,
  evGate,
  priorKindFor,
  type AttemptBound,
  type ConsentState,
  type ContactBound,
  type EvArithmetic,
  type Policy,
  type PriorTable,
  type Timing,
} from '@rc/policy';

/**
 * PLANNING ONE ACTION
 *
 * Given everything observable about a failed payment, decide what — if anything — happens
 * next. Pure: no database, no clock of its own, no gateway. `now` and the observed history
 * arrive as arguments, which is what makes the whole decision surface property-testable.
 *
 * The output maps one-to-one onto a row in `decision`, including for refusals. Every plan
 * carries the full expected-value arithmetic, even when nothing fires, because "why didn't
 * you try?" is the question this system exists to answer and the answer has to be in
 * rupees rather than prose.
 *
 * There is no model anywhere in this file. The LLM's contribution arrives upstream, as the
 * `reasonCode`, and its influence ends there.
 */

/**
 * Actions whose entire mechanism is the message.
 *
 * For these there is no `notify: true` to set — sending IS the action, so a step that is
 * blocked from contacting the customer has not merely lost its nudge, it has not happened.
 */
const MESSAGE_IS_THE_ACTION: ReadonlySet<string> = new Set([
  'payment_link',
  'notify',
  'pre_debit_notify',
  'remandate',
]);

/**
 * How many times the amount is at stake.
 *
 * Only recurring classes multiply. A one-off payment failure risks one amount however many
 * times it is retried, and applying a lifetime multiplier there would inflate every value
 * in the system by a factor nobody chose.
 */
function valueCyclesFor(input: PlanInput): number {
  if (!RISK_CLASS_META[input.riskClass].recurring) return 1;
  return input.lifetimeCycles ?? input.policy.defaultLifetimeCycles;
}

export interface TemplateRef {
  readonly id: TemplateId;
  readonly channel: Channel;
  /** DLT-registered. An unregistered template cannot legally be sent in India. */
  readonly registered: boolean;
}

export interface PlanInput {
  readonly now: Date;
  readonly policy: Policy;
  readonly priors: PriorTable;

  readonly reasonCode: ReasonCode;
  /**
   * What kind of revenue is at risk.
   *
   * Determines the strategy, the legal interventions, and how the value term is computed.
   * One engine, five classes — not five systems — because the differences turned out to be
   * data the gate already takes as input rather than separate code paths.
   */
  readonly riskClass: RiskClass;
  readonly amount: Paise;
  readonly marginBps: Bps;
  /**
   * Billing cycles still to come, for a recurring charge.
   *
   * Null means "use the policy default"; ignored entirely for non-recurring classes, where
   * the value at stake really is one amount.
   */
  readonly lifetimeCycles: number | null;
  /** The rail the payment failed on. A `switch_rail` step moves off it. */
  readonly currentRail: Rail;

  /** 1-indexed. The number of attempts already FIRED, plus one. Refusals do not count. */
  readonly attemptNo: number;
  readonly hoursSinceLastAttempt: number | null;

  readonly contactsThisWeek: number;
  readonly callsThisWeek: number;
  readonly consent: ConsentState;
  /** Resolved by the caller from the policy's template id. Null when none exists. */
  readonly template: TemplateRef | null;
  readonly onNcprRegistry: boolean;

  /** True when the debit runs on a live e-mandate, which requires a pre-debit notice. */
  readonly mandateBacked: boolean;
  readonly hoursSincePreDebitNotice: number | null;
  /** A promise-to-pay date still in the future, if the buyer has made one. */
  readonly openPromiseDueAt: Date | null;

  readonly batchFeeRemaining: Paise;
}

export type ContactPlan =
  | { readonly send: true; readonly channel: Channel; readonly templateId: TemplateId }
  | {
      readonly send: false;
      /** `not_scheduled` means the policy never intended a message at this step. */
      readonly blockedBy: ContactBound | 'not_scheduled';
      readonly detail: string;
    };

export type Plan =
  | {
      readonly kind: 'fire';
      readonly action:
        | 'retry'
        | 'switch_rail'
        | 'payment_link'
        | 'notify'
        | 'pre_debit_notify'
        | 'remandate';
      readonly rail: Rail;
      readonly timing: Timing;
      readonly ev: EvArithmetic;
      readonly contact: ContactPlan;
    }
  | {
      readonly kind: 'refuse';
      readonly verdict: Exclude<Verdict, 'fire'>;
      /**
       * `escalate` hands the transaction to a human; `none` closes it; `await_promise` is
       * deliberate inaction because the buyer has committed to a date that has not arrived.
       *
       * The third is not a variety of "nothing happened". A ladder suppressed by a promise
       * is a decision with a reason, and an operator looking at a silent invoice needs to
       * see which of the two it was.
       */
      readonly action: 'escalate' | 'none' | 'await_promise';
      /**
       * WHICH rule refused, as a value rather than as prose.
       *
       * `detail` is for the human reading one exception; this is for the aggregate. Without
       * it, "what did the consent bound cost us this batch?" meant grepping English
       * sentences — and that number is the price of the compliance envelope, which is worth
       * stating out loud rather than leaving as an unexplained shortfall against the ceiling.
       */
      readonly rule: RefuseRule;
      readonly detail: string;
      readonly ev: EvArithmetic;
      readonly contact: ContactPlan;
    };

/**
 * Every reason a decision can be refused.
 *
 * `ev_floor` is the only one that is not a bound: it is the economics declining to spend, and
 * keeping it in the same enumeration is what lets one report line compare the cost of
 * prudence against the cost of compliance.
 */
export type RefuseRule = AttemptBound | ContactBound | 'ev_floor';

/**
 * Map a blocked attempt bound onto the verdict recorded in the database.
 *
 * The kill switch and structural impossibility get their own verdicts rather than being
 * folded into `refuse_bounds`, because they are the two an operator most needs to
 * distinguish at a glance: one means the system is halted, the other means the transaction
 * was never recoverable. Everything else is a bound doing its job.
 */
function verdictFor(bound: AttemptBound): Exclude<Verdict, 'fire'> {
  switch (bound) {
    case 'kill_switch':
      return 'refuse_kill_switch';
    // Both mean the action cannot succeed or cannot lawfully happen, as opposed to being
    // permitted but unwise. An operator reading `refuse_terminal` knows not to go looking
    // for a threshold to lower.
    case 'terminal':
    case 'illegal_intervention':
      return 'refuse_terminal';
    case 'attempt_cap':
    case 'min_gap':
    case 'batch_fee_budget':
    case 'pre_debit_notice':
    case 'promise_open':
      return 'refuse_bounds';
    default:
      return assertNever(bound, 'verdictFor');
  }
}

export function planNext(input: PlanInput): Plan {
  const { policy, priors, reasonCode, riskClass, attemptNo } = input;

  const reason = policy.forReason(reasonCode, riskClass);
  const entry = policy.scheduleEntry(reasonCode, attemptNo, riskClass);

  // The rail this step would use. A switch_rail entry names its target; anything else
  // re-presents on the rail that failed.
  const rail = entry?.rail ?? input.currentRail;

  // ---- contact intent -----------------------------------------------------
  // Three sources now: a step whose entire mechanism IS the message (a payment link, a
  // pre-debit notice, a re-authorisation request), a charging step with `notify: true`, or
  // an escalation configured to tell the customer. All three are intentions; the bounds
  // below decide whether they happen.
  const wantsContact =
    entry !== undefined
      ? entry.notify || MESSAGE_IS_THE_ACTION.has(entry.action)
      : reason.escalate && reason.notify_on_escalate;

  const contact = planContact(input, wantsContact, entry?.action === 'pre_debit_notify');

  // ---- costs --------------------------------------------------------------
  // Charged whether or not the attempt works, which is the whole reason net value differs
  // from recovery rate. Message cost is zero when nothing is actually sent — a suppressed
  // nudge must not be billed against the transaction that never received it.
  //
  // A gateway fee applies ONLY to actions that present a charge. An abandoned checkout was
  // never charged and a receivable reminder charges nothing, so pricing those at a card
  // fee would make the gate refuse eighteen-paise interventions on the strength of a
  // ₹3.50 cost that does not exist.
  const gatewayFee =
    entry === undefined || !incursGatewayFee(entry.action) ? ZERO : policy.gatewayFee(rail);
  const messageCost = contact.send ? policy.messageCost(contact.channel) : ZERO;

  // ---- probability --------------------------------------------------------
  // From the PUBLISHED priors. The policy is permitted to be wrong here; that is the
  // Chinese wall, and this lookup is the only place the wall is load-bearing at runtime.
  //
  // Keyed on the prior KIND as well as the timing, because "will a retry succeed at hour
  // 72" and "will this customer re-authorise their mandate" are different questions. Before
  // that distinction existed, a lapsed mandate was a structural zero full stop, and the
  // engine was structurally unable to recover revenue it can in fact collect.
  const lookup =
    entry === undefined
      ? undefined
      : priors.prior(reasonCode, attemptNo, entry.timing, priorKindFor(entry.action));

  const pBps: Bps =
    lookup === undefined || lookup.kind !== 'prior' ? bps(0) : lookup.pBps;

  // Evaluated once. The arithmetic is attached to every plan the function can return —
  // including refusals, so a blocked transaction can still say what it would have been
  // worth — and the verdict is consulted later, after the bounds have had their say.
  const economics = evGate({
    amount: input.amount,
    marginBps: input.marginBps,
    valueCycles: valueCyclesFor(input),
    pBps,
    gatewayFee,
    messageCost,
    llmCost: policy.llmAmortisedCost,
    floor: policy.evFloor,
  });
  const ev = economics.arithmetic;

  // ---- a missing prior is a configuration bug, not a refusal --------------
  // Surfaced loudly rather than coerced to zero. A silent zero would look exactly like a
  // correct structural refusal, and the policy would appear to be working while
  // systematically declining a whole class of recoverable payments.
  if (lookup?.kind === 'missing') {
    throw new Error(
      `Policy schedules ${reasonCode} attempt ${attemptNo} at "${entry?.timing ?? '?'}" ` +
        `but priors.published.yaml has no entry for it. ${lookup.detail}`,
    );
  }

  // ---- attempt bounds -----------------------------------------------------
  const attemptVerdict = checkAttemptBounds({
    now: input.now,
    policy,
    reasonCode,
    riskClass,
    // With no scheduled step there is no intervention to check for legality, and `none` is
    // legal everywhere — so the bounds fall through to the cap check, which is the honest
    // reason a code with an empty schedule cannot act.
    intervention: entry?.action ?? 'none',
    attemptNo,
    hoursSinceLastAttempt: input.hoursSinceLastAttempt,
    batchFeeRemaining: input.batchFeeRemaining,
    gatewayFee,
    mandateBacked: input.mandateBacked,
    hoursSincePreDebitNotice: input.hoursSincePreDebitNotice,
    openPromiseDueAt: input.openPromiseDueAt,
  });

  if (attemptVerdict.kind === 'block') {
    return {
      kind: 'refuse',
      verdict: verdictFor(attemptVerdict.rule),
      rule: attemptVerdict.rule,
      // A terminal code that the policy says to escalate still gets escalated. The
      // attempt is refused; the transaction is not abandoned.
      //
      // An open promise is the exception: escalating it would put a human in front of an
      // invoice whose buyer has already committed to a date. Recorded as deliberate
      // waiting so the audit trail distinguishes it from an idle transaction.
      action:
        attemptVerdict.rule === 'promise_open'
          ? 'await_promise'
          : reason.escalate
            ? 'escalate'
            : 'none',
      detail: attemptVerdict.detail,
      ev,
      contact,
    };
  }

  // `entry` is defined here: `checkAttemptBounds` blocks when the attempt number exceeds
  // the schedule, so passing it means a step exists.
  if (entry === undefined) {
    throw new Error(
      `unreachable: attempt ${attemptNo} passed bounds for ${reasonCode} with no schedule entry`,
    );
  }

  // ---- an action that IS a message cannot fire without the message ---------
  //
  // THE BUG THIS FIXES INFLATED THIS SYSTEM'S OWN RESULTS, which is the kind worth writing
  // down rather than quietly correcting. `planNext` returned `fire` with
  // `contact.send: false` whenever a contact bound — consent, quiet hours, the weekly
  // ceiling — suppressed the message. For a RETRY that is exactly right: the attempt
  // proceeds silently and the suppressed nudge is audited on its own. For a payment link, a
  // pre-debit notice or a re-authorisation request it is nonsense, because the message is
  // the whole intervention — so "fired, sent nothing" had the simulator draw a success
  // probability for a link no customer ever received.
  //
  // The controller was being credited with recoveries from messages it had itself decided
  // not to send, and the effect was largest in precisely the classes that recover by
  // messaging.
  //
  // Checked after the bounds and before the economics, in keeping with the rest of this
  // function: authorisation first, so a halted system reports the kill switch rather than a
  // consent problem, and no point pricing an action that cannot happen.
  if (MESSAGE_IS_THE_ACTION.has(entry.action) && !contact.send) {
    return {
      kind: 'refuse',
      // A missing or unregistered template, or a cause that must never be contacted, is a
      // structural dead end rather than a bound that will lapse. Reporting those as
      // `refuse_bounds` would invite an operator to wait for a window that never opens.
      verdict:
        contact.blockedBy === 'no_template' || contact.blockedBy === 'never_contact'
          ? 'refuse_terminal'
          : 'refuse_bounds',
      // `not_scheduled` is unreachable here: a message-only action always wants a contact, so
      // `planContact` was called with `wantsContact: true`. Mapped rather than cast so a
      // future refactor that made it reachable would surface as a wrong report line rather
      // than as a type error nobody sees.
      rule: contact.blockedBy === 'not_scheduled' ? 'no_template' : contact.blockedBy,
      action: reason.escalate ? 'escalate' : 'none',
      detail:
        `${entry.action} is a message and nothing else, so it cannot fire without one. ` +
        contact.detail,
      ev,
      contact,
    };
  }

  // ---- economics ----------------------------------------------------------
  // Consulted last, and deliberately so: the bounds answer questions of authorisation,
  // and there is no point pricing an action nobody is permitted to take. A transaction
  // blocked by quiet hours should report the quiet hours, not a marginal expected value.
  if (economics.kind === 'fail') {
    return {
      kind: 'refuse',
      verdict: 'refuse_ev',
      rule: 'ev_floor',
      action: reason.escalate ? 'escalate' : 'none',
      detail: economics.detail,
      ev,
      contact,
    };
  }

  return { kind: 'fire', action: entry.action, rail, timing: entry.timing, ev, contact };
}

function planContact(
  input: PlanInput,
  wantsContact: boolean,
  mandatoryNotice: boolean,
): ContactPlan {
  if (!wantsContact) {
    return {
      send: false,
      blockedBy: 'not_scheduled',
      detail: 'The policy does not send a message at this step.',
    };
  }

  const template = input.template;
  if (template === null || !template.registered) {
    return {
      send: false,
      blockedBy: 'no_template',
      detail:
        template === null
          ? `No template configured for ${input.reasonCode}.`
          : `Template ${template.id} is not DLT-registered and cannot be sent.`,
    };
  }

  const verdict = checkContactBounds({
    now: input.now,
    policy: input.policy,
    reasonCode: input.reasonCode,
    channel: template.channel,
    consent: input.consent,
    contactsThisWeek: input.contactsThisWeek,
    callsThisWeek: input.callsThisWeek,
    hasRegisteredTemplate: template.registered,
    onNcprRegistry: input.onNcprRegistry,
    mandatoryNotice,
  });

  if (verdict.kind === 'block') {
    return { send: false, blockedBy: verdict.rule, detail: verdict.detail };
  }

  return { send: true, channel: template.channel, templateId: template.id };
}
