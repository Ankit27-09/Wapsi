import {
  RISK_CLASS_META,
  ZERO,
  bps,
  mayEverContact,
  type Bps,
  type Paise,
  type Rail,
  type ReasonCode,
  type RiskClass,
} from '@rc/core';
import type { Arm as ArmId } from '@rc/db';
import { planNext, type Plan, type PlanInput } from '@rc/engine';
import {
  PRIOR_KINDS,
  TIMINGS,
  evGate,
  type PriorKind,
  type PriorTable,
  type Timing,
} from '@rc/policy';
import type { TruthModel } from '@rc/simulator';

/**
 * THE ARMS
 *
 * Each arm is a different answer to "what should we do about this failed payment?", run
 * over an identical seeded population. Differences in the results are therefore
 * differences in strategy rather than in luck, which is the only way the comparison means
 * anything.
 *
 * Returning `null` means the arm takes no further action on this transaction.
 *
 * Every arm's decisions go through the same `executeDecision`, so all of them get the
 * same idempotency, the same fee budget, the same audit trail. Only the strategy varies —
 * and notably, the baselines are NOT bound by the policy's caps or its expected-value
 * gate. That is what makes them naive rather than merely different.
 */

/**
 * What an arm is allowed to see.
 *
 * `truth` is present only for the oracle. Declaring it in the type rather than reaching for
 * it through a shared context is the same principle the classifier signature follows: an
 * arm that can read the answer should have to say so, and no arm that could ship can
 * acquire that access by accident.
 */
export interface ArmContext {
  readonly priors: PriorTable;
  readonly truth?: {
    readonly model: TruthModel;
    /** Unobservable to any real policy. The oracle's whole advantage. */
    readonly issuerId: string;
  };
}

export interface Arm {
  readonly id: ArmId;
  readonly label: string;
  readonly description: string;
  plan(input: PlanInput, context: ArmContext): Plan | null;
}

/**
 * The published prior for a situation, or zero when the table has no belief about it.
 *
 * Used only by the baselines. Zero-for-missing is honest here rather than dangerous: it
 * says the published evidence offers no reason to expect this action to work, which is
 * exactly true of an immediate re-present of a `do_not_honour` decline — nobody does that,
 * so nobody has measured it.
 *
 * The Recovery Controller uses `priors.prior` directly, where a missing entry is a
 * configuration bug and throws. The difference is deliberate: the policy is only allowed
 * to act on situations it has evidence about; a baseline acts regardless, and pricing its
 * actions at zero is how the report quantifies the waste.
 */
function priorOrZero(
  priors: PriorTable,
  code: ReasonCode,
  attempt: number,
  timing: Timing,
  kind: PriorKind = 'charge',
): Bps {
  const lookup = priors.prior(code, attempt, timing, kind);
  return lookup.kind === 'prior' ? lookup.pBps : bps(0);
}

/**
 * Whether a charge is even possible for this class.
 *
 * The retry baselines fire on everything WITHIN THE DOMAIN THEY EXIST IN, and that domain is
 * payments. An abandoned checkout has no instrument to re-present and an invoice is not a
 * card, so making B1 and B2 "retry" those would not be naive — it would be a strawman that
 * spends fees on physically impossible actions and flatters the controller by comparison.
 *
 * The honest baseline for the messaging classes is B4 below.
 */
function canCharge(riskClass: RiskClass): boolean {
  return RISK_CLASS_META[riskClass].interventions.includes('retry');
}

/**
 * Price an action the way the Recovery Controller would have, without gating on it.
 *
 * This is what lets the report say "retry-everything fired N attempts whose expected value
 * was negative, costing ₹X" — the baseline's waste measured against the policy's own
 * published beliefs, rather than against hindsight.
 */
function priceAction(
  input: PlanInput,
  priors: PriorTable,
  attempt: number,
  timing: Timing,
): Plan {
  const { policy } = input;
  const arithmetic = evGate({
    amount: input.amount,
    marginBps: input.marginBps,
    // ONE cycle, even on a subscription, and this is not an oversight. A fixed retry rule
    // does not know a subscription from a one-off — that knowledge is precisely what the
    // controller has and the baseline does not. Giving the baseline the lifetime multiplier
    // would hand it half the controller's advantage for free.
    valueCycles: 1,
    pBps: priorOrZero(priors, input.reasonCode, attempt, timing),
    gatewayFee: policy.gatewayFee(input.currentRail),
    // Zero, because the baselines never contact anyone — the plan below sets
    // `contact.send: false`. An earlier version charged an SMS here anyway, which
    // understated every baseline's expected value by ₹0.18 an attempt and pushed more of
    // them below zero than truly were. That inflated the "negative expected value
    // attempts" figure IN FAVOUR OF the controller, which is the one direction a
    // comparison like this must not be wrong in.
    messageCost: ZERO,
    llmCost: policy.llmAmortisedCost,
    floor: policy.evFloor,
  }).arithmetic;

  return {
    kind: 'fire',
    action: 'retry',
    rail: input.currentRail,
    timing,
    ev: arithmetic,
    contact: {
      send: false,
      blockedBy: 'not_scheduled',
      detail: 'Baseline arms do not message customers; only the retry behaviour differs.',
    },
  };
}

/** The submission. Full planner: EV gate, bounds, schedule, consent. */
export const RECOVERY_CONTROLLER: Arm = {
  id: 'rc',
  label: 'Recovery Controller',
  description:
    'Diagnoses root cause, gates every action on expected value, respects the policy ' +
    'envelope, stops when stopping rules fire, escalates what it cannot resolve.',
  plan: (input) => planNext(input),
};

/** Do nothing. Establishes the size of the prize. */
export const DO_NOTHING: Arm = {
  id: 'b0',
  label: 'Do nothing',
  description:
    'No attempts, no contacts, no fees. The counterfactual every other number is ' +
    'measured against, and the one most merchants are actually running.',
  plan: () => null,
};

/**
 * One immediate retry on everything.
 *
 * Deliberately ignores the taxonomy: it re-presents an expired card and a revoked mandate
 * with the same enthusiasm as a transient timeout. This is not a strawman — it is what a
 * fixed retry rule in a payment integration actually does, and isolating it answers
 * whether the value is in the RETRYING or in the TARGETING.
 */
export const RETRY_ALL_IMMEDIATELY: Arm = {
  id: 'b1',
  label: 'Retry all, immediately',
  description:
    'A single immediate re-present on every failure, regardless of cause. Isolates ' +
    'whether the value is in retrying at all, or in choosing what and when to retry.',
  plan: (input, context) =>
    input.attemptNo === 1 && canCharge(input.riskClass)
      ? priceAction(input, context.priors, 1, 'immediate')
      : null,
};

/**
 * Classic dunning: a fixed schedule, every cause treated alike.
 *
 * THE ARM THAT MATTERS MOST FOR THE HEADLINE CLAIM.
 *
 * B1 takes one attempt while the Recovery Controller takes up to three, so part of the
 * controller's advantage over B1 is simply volume rather than judgement. B2 removes that
 * confound: same attempt budget, same fee exposure, no targeting. Whatever separates the
 * controller from B2 is the value of DIAGNOSING the failure rather than merely persisting.
 *
 * Day 1 / day 3 / day 7 is what dunning tools actually ship. Modelled here as three
 * generic next-day attempts, which is the closest the timing vocabulary expresses — a real
 * limitation, and one that flatters B2 slightly, since a genuine day-7 attempt is worse
 * than another day-1 attempt.
 */
export const FIXED_SCHEDULE_DUNNING: Arm = {
  id: 'b2',
  label: 'Fixed-schedule dunning',
  description:
    'Three attempts on a fixed cadence, identical for every failure cause. Same attempt ' +
    'budget as the controller, no diagnosis — so the gap between them is the value of ' +
    'targeting rather than of persistence.',
  plan: (input, context) =>
    input.attemptNo > 3 || !canCharge(input.riskClass)
      ? null
      : priceAction(input, context.priors, input.attemptNo, 'next_day'),
};

/**
 * Blast the same reminder at everything, three times.
 *
 * THE BASELINE THE MESSAGING CLASSES NEED, and the exact analogue of B2 for the domains
 * where there is nothing to charge. Checkout abandonment and overdue receivables cannot be
 * retried, so B1 and B2 sit them out — and without this arm the controller's results there
 * would only be measurable against doing nothing, which is a much easier bar.
 *
 * What it does is what an off-the-shelf abandoned-cart or dunning tool does: one generic
 * message per transaction on a fixed cadence, no diagnosis, no expected-value gate, no
 * contact ceiling. The gap between this and the controller is therefore the value of
 * TARGETING — knowing that an OTP drop-off is worth chasing within minutes and a browsing
 * cart may not be worth chasing at all.
 *
 * It does respect `never_contact`. A baseline that messaged fraud-flagged customers would be
 * cheaper to beat and would not correspond to anything anyone could actually run, so the
 * comparison would be worthless in the one direction it must not be.
 */
export const BLAST_ALL_REMINDERS: Arm = {
  id: 'b4',
  label: 'Blast reminders at everything',
  description:
    'Three generic reminders per transaction on a fixed cadence, no diagnosis and no ' +
    'expected-value gate — what an off-the-shelf abandoned-cart or dunning tool does. The ' +
    'targeting baseline for the classes that cannot be retried.',

  plan: (input, context) => {
    if (input.attemptNo > 3) return null;
    if (!mayEverContact(input.reasonCode)) return null;

    // No registered template means no message, and this arm is nothing BUT a message — so
    // there is no action to take. Returning a `fire` with nothing sent would have the
    // simulator draw an outcome for a reminder that never existed, which is the same bug the
    // controller had and would inflate the baseline instead.
    if (input.template === null || !input.template.registered) return null;

    // Priced as `notify`, which is what it is: one message, no fee. The prior consulted is
    // the published one for a notify at this timing, and it is usually MISSING — the table
    // has no belief about sending a generic reminder to an abandoned cart, because nobody
    // schedules that. Zero-for-missing is the honest price of an action with no evidence
    // behind it, and it is how the report quantifies untargeted messaging as waste.
    const timing: Timing = input.attemptNo === 1 ? 'next_day' : 'payment_run_window';
    const messageCost = input.policy.messageCost('sms');

    const arithmetic = evGate({
      amount: input.amount,
      marginBps: input.marginBps,
      valueCycles: 1,
      pBps: priorOrZero(context.priors, input.reasonCode, input.attemptNo, timing, 'notify'),
      gatewayFee: ZERO,
      messageCost,
      llmCost: ZERO,
      floor: ZERO,
    }).arithmetic;

    return {
      kind: 'fire',
      action: 'notify',
      rail: input.currentRail,
      timing,
      ev: arithmetic,
      // Consent, quiet hours and the weekly ceiling are all ignored — that is what makes
      // this a naive baseline. Template registration is not, because it is a legal
      // constraint rather than a policy preference, and a baseline that sent unregistered
      // templates would not correspond to anything anyone could run.
      contact: {
        send: true,
        channel: input.template.channel,
        templateId: input.template.id,
      },
    };
  },
};

/**
 * The oracle: perfect knowledge, optimal play.
 *
 * Reads the simulator's ground truth INCLUDING the per-issuer effect the policy cannot
 * observe, evaluates every timing available, and fires whichever maximises real expected
 * value — stopping the moment nothing positive remains.
 *
 * Not a strategy. A CEILING. It converts the headline from "we beat naive retry", which
 * invites the question *by how much of what was possible?*, into "we captured X% of what
 * was achievable" — a claim with a scale attached. Nothing here is shippable: no
 * production system can read the outcome before choosing the action.
 */
export const ORACLE: Arm = {
  id: 'b3_oracle',
  label: 'Oracle (ceiling)',
  description:
    'Plays optimally against the true outcome distribution, including the per-issuer ' +
    'effect no real policy can observe. The upper bound every other arm is reported ' +
    'against.',

  plan: (input, context) => {
    const truth = context.truth;
    if (truth === undefined) {
      throw new Error(
        'The oracle arm requires the truth model. It is the only arm permitted to read ' +
          'it, and it cannot function without it.',
      );
    }

    // A budget the oracle also has to respect: a ceiling that could spend without limit
    // would not be a ceiling for a bounded system.
    if (input.attemptNo > 3) return null;

    // NOTE ON WHAT THIS USED TO SAY.
    //
    // The line here was `if (isTerminal(input.reasonCode)) return null` — physics, not
    // economics, nothing recovers an expired card. True for a RETRY, and it became badly
    // wrong the moment the system modelled anything else: all nine of the checkout and
    // receivable causes are terminal, because nothing was ever charged. So the oracle would
    // have declined to act on every one of them, the ceiling for four of the five risk
    // classes would have been exactly zero, and "we captured X% of what was achievable"
    // would have read as 100% — or divided by zero — precisely where the new work happens.
    //
    // The correct statement is per (class, intervention): the search below simply skips any
    // action whose TRUE probability is zero, which covers expired cards and revoked mandates
    // without also writing off the eight-paise nudge that recovers an abandoned cart.

    const legal = RISK_CLASS_META[input.riskClass].interventions;
    const messageCost = input.policy.messageCost('sms');

    /**
     * A CEILING BOUNDED BY LAW, NOT BY PREFERENCE.
     *
     * The oracle ignores every constraint that is a merchant's risk preference — the
     * expected-value floor, the attempt cap, the weekly contact ceiling — because those are
     * choices, and a ceiling exists to measure what was left on the table by choosing.
     *
     * It does NOT ignore the pre-debit notification. That is not a preference; it is the
     * condition under which an e-mandate debit is lawful at all. An oracle that debits
     * without notice is not a ceiling, it is a fantasy — and reporting the controller as a
     * percentage of a fantasy understates it by comparing it against something nobody is
     * permitted to do. Before this check, the controller measured 34.6% of the subscription
     * ceiling; the missing two thirds were charges the oracle was not entitled to make.
     */
    const chargeIsLawful =
      !input.mandateBacked ||
      (input.hoursSincePreDebitNotice !== null &&
        input.hoursSincePreDebitNotice >= input.policy.preDebitNoticeHours);

    interface Candidate {
      readonly timing: Timing;
      readonly kind: PriorKind;
      readonly action: 'retry' | 'switch_rail' | 'payment_link' | 'notify' | 'pre_debit_notify' | 'remandate';
      readonly rail: Rail;
      readonly net: Paise;
    }

    const priceOracle = (
      timing: Timing,
      kind: PriorKind,
      rail: Rail,
    ): { readonly pBps: Bps; readonly net: Paise; readonly passes: boolean } => {
      const pBps = truth.model.successProbability(
        input.reasonCode,
        input.attemptNo,
        timing,
        truth.issuerId,
        kind,
      );
      const verdict = evGate({
        amount: input.amount,
        marginBps: input.marginBps,
        // The oracle sees the true horizon too. Withholding it would understate the ceiling
        // and flatter the controller against it.
        valueCycles: RISK_CLASS_META[input.riskClass].recurring
          ? (input.lifetimeCycles ?? input.policy.defaultLifetimeCycles)
          : 1,
        pBps,
        gatewayFee: kind === 'charge' ? input.policy.gatewayFee(rail) : ZERO,
        messageCost: kind === 'charge' ? ZERO : messageCost,
        llmCost: ZERO,
        // Fires on any positive expected value. The policy's floor is a risk preference;
        // the ceiling is what a perfectly informed actor could extract.
        floor: ZERO,
      });
      return {
        pBps,
        net: verdict.arithmetic.net,
        passes: verdict.kind === 'pass',
      };
    };

    let best: Candidate | null = null;

    for (const timing of TIMINGS) {
      for (const kind of PRIOR_KINDS) {
        // A `charge` kind covers both retry and switch_rail; `alt_rail` is what makes it the
        // latter, which is the same convention the prior table uses.
        const action =
          kind === 'charge' ? (timing === 'alt_rail' ? 'switch_rail' : 'retry') : kind;
        if (!legal.includes(action)) continue;
        if (kind === 'charge' && !chargeIsLawful) continue;
        // A non-charging action is a message. With no registered template there is no
        // message and therefore no action — even for a ceiling, since an unregistered
        // template cannot lawfully be sent by anybody.
        if (kind !== 'charge' && (input.template === null || !input.template.registered)) {
          continue;
        }

        const rail = timing === 'alt_rail' ? 'upi_intent' : input.currentRail;
        const priced = priceOracle(timing, kind, rail);
        if (priced.pBps === 0 || !priced.passes) continue;

        if (best === null || priced.net > best.net) {
          best = { timing, kind, action, rail, net: priced.net };
        }
      }
    }

    if (best === null) return null;

    const chosen = priceOracle(best.timing, best.kind, best.rail);

    return {
      kind: 'fire',
      action: best.action,
      rail: best.rail,
      timing: best.timing,
      ev: evGate({
        amount: input.amount,
        marginBps: input.marginBps,
        valueCycles: RISK_CLASS_META[input.riskClass].recurring
          ? (input.lifetimeCycles ?? input.policy.defaultLifetimeCycles)
          : 1,
        pBps: chosen.pBps,
        gatewayFee: best.kind === 'charge' ? input.policy.gatewayFee(best.rail) : ZERO,
        messageCost: best.kind === 'charge' ? ZERO : messageCost,
        llmCost: ZERO,
        floor: ZERO,
      }).arithmetic,
      // A non-charging action IS the message, so the oracle has to send it — and pay for it.
      //
      // Not cosmetic. A pre-debit notice that was never delivered does not make the debit
      // 24 hours later lawful, and the notice is read back from `message_send` rather than
      // from the decision that planned it. An oracle that priced the notice and skipped
      // sending it would find every subsequent charge refused, and the subscription ceiling
      // would collapse to whatever a message alone recovers.
      //
      // What the ceiling therefore assumes, stated plainly: every customer is reachable.
      // Consent, quiet hours and the weekly ceiling are merchant-side preferences the oracle
      // is entitled to ignore, so this is a generous ceiling — in the direction that makes
      // the controller's share of it a conservative claim rather than a flattering one.
      contact:
        best.kind === 'charge' || input.template === null || !input.template.registered
          ? {
              send: false,
              blockedBy: best.kind === 'charge' ? 'not_scheduled' : 'no_template',
              detail:
                best.kind === 'charge'
                  ? 'A charge sends no message.'
                  : 'No registered template exists for this cause, so even the ceiling cannot send.',
            }
          : {
              send: true,
              channel: input.template.channel,
              templateId: input.template.id,
            },
    };
  },
};

export const ARMS: readonly Arm[] = [
  DO_NOTHING,
  RETRY_ALL_IMMEDIATELY,
  FIXED_SCHEDULE_DUNNING,
  BLAST_ALL_REMINDERS,
  ORACLE,
  RECOVERY_CONTROLLER,
];

export function armById(id: ArmId): Arm {
  const arm = ARMS.find((candidate) => candidate.id === id);
  if (arm === undefined) {
    throw new Error(
      `Arm "${id}" is not implemented yet. Available: ${ARMS.map((a) => a.id).join(', ')}`,
    );
  }
  return arm;
}
