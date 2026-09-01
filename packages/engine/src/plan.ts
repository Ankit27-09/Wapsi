import {
  ZERO,
  assertNever,
  bps,
  type Bps,
  type Channel,
  type Paise,
  type Rail,
  type ReasonCode,
  type TemplateId,
} from '@rc/core';
import type { Verdict } from '@rc/db';
import {
  checkAttemptBounds,
  checkContactBounds,
  evGate,
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
  readonly amount: Paise;
  readonly marginBps: Bps;
  /** The rail the payment failed on. A `switch_rail` step moves off it. */
  readonly currentRail: Rail;

  /** 1-indexed. The number of attempts already FIRED, plus one. Refusals do not count. */
  readonly attemptNo: number;
  readonly hoursSinceLastAttempt: number | null;

  readonly contactsThisWeek: number;
  readonly consent: ConsentState;
  /** Resolved by the caller from the policy's template id. Null when none exists. */
  readonly template: TemplateRef | null;

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
      readonly action: 'retry' | 'switch_rail';
      readonly rail: Rail;
      readonly timing: Timing;
      readonly ev: EvArithmetic;
      readonly contact: ContactPlan;
    }
  | {
      readonly kind: 'refuse';
      readonly verdict: Exclude<Verdict, 'fire'>;
      /** `escalate` hands the transaction to a human; `none` closes it. */
      readonly action: 'escalate' | 'none';
      readonly detail: string;
      readonly ev: EvArithmetic;
      readonly contact: ContactPlan;
    };

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
    case 'terminal':
      return 'refuse_terminal';
    case 'attempt_cap':
    case 'min_gap':
    case 'batch_fee_budget':
      return 'refuse_bounds';
    default:
      return assertNever(bound, 'verdictFor');
  }
}

export function planNext(input: PlanInput): Plan {
  const { policy, priors, reasonCode, attemptNo } = input;

  const reason = policy.forReason(reasonCode);
  const entry = policy.scheduleEntry(reasonCode, attemptNo);

  // The rail this step would use. A switch_rail entry names its target; anything else
  // re-presents on the rail that failed.
  const rail = entry?.rail ?? input.currentRail;

  // ---- contact intent -----------------------------------------------------
  // Two sources: a scheduled step with `notify: true`, or an escalation configured to
  // tell the customer. Both are intentions; the bounds below decide whether they happen.
  const wantsContact =
    entry !== undefined ? entry.notify : reason.escalate && reason.notify_on_escalate;

  const contact = planContact(input, wantsContact);

  // ---- costs --------------------------------------------------------------
  // Charged whether or not the attempt works, which is the whole reason net value differs
  // from recovery rate. Message cost is zero when nothing is actually sent — a suppressed
  // nudge must not be billed against the transaction that never received it.
  const gatewayFee = entry === undefined ? ZERO : policy.gatewayFee(rail);
  const messageCost = contact.send ? policy.messageCost(contact.channel) : ZERO;

  // ---- probability --------------------------------------------------------
  // From the PUBLISHED priors. The policy is permitted to be wrong here; that is the
  // Chinese wall, and this lookup is the only place the wall is load-bearing at runtime.
  const lookup =
    entry === undefined
      ? undefined
      : priors.prior(reasonCode, attemptNo, entry.timing);

  const pBps: Bps =
    lookup === undefined || lookup.kind !== 'prior' ? bps(0) : lookup.pBps;

  // Evaluated once. The arithmetic is attached to every plan the function can return —
  // including refusals, so a blocked transaction can still say what it would have been
  // worth — and the verdict is consulted later, after the bounds have had their say.
  const economics = evGate({
    amount: input.amount,
    marginBps: input.marginBps,
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
    attemptNo,
    hoursSinceLastAttempt: input.hoursSinceLastAttempt,
    batchFeeRemaining: input.batchFeeRemaining,
    gatewayFee,
  });

  if (attemptVerdict.kind === 'block') {
    return {
      kind: 'refuse',
      verdict: verdictFor(attemptVerdict.rule),
      // A terminal code that the policy says to escalate still gets escalated. The
      // attempt is refused; the transaction is not abandoned.
      action: reason.escalate ? 'escalate' : 'none',
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

  // ---- economics ----------------------------------------------------------
  // Consulted last, and deliberately so: the bounds answer questions of authorisation,
  // and there is no point pricing an action nobody is permitted to take. A transaction
  // blocked by quiet hours should report the quiet hours, not a marginal expected value.
  if (economics.kind === 'fail') {
    return {
      kind: 'refuse',
      verdict: 'refuse_ev',
      action: reason.escalate ? 'escalate' : 'none',
      detail: economics.detail,
      ev,
      contact,
    };
  }

  return { kind: 'fire', action: entry.action, rail, timing: entry.timing, ev, contact };
}

function planContact(input: PlanInput, wantsContact: boolean): ContactPlan {
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
    hasRegisteredTemplate: template.registered,
  });

  if (verdict.kind === 'block') {
    return { send: false, blockedBy: verdict.rule, detail: verdict.detail };
  }

  return { send: true, channel: template.channel, templateId: template.id };
}
