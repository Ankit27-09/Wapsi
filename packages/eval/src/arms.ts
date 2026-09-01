import { ZERO, bps, isTerminal, type Bps, type Paise, type ReasonCode } from '@rc/core';
import type { Arm as ArmId } from '@rc/db';
import { planNext, type Plan, type PlanInput } from '@rc/engine';
import { TIMINGS, evGate, type PriorTable, type Timing } from '@rc/policy';
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
): Bps {
  const lookup = priors.prior(code, attempt, timing);
  return lookup.kind === 'prior' ? lookup.pBps : bps(0);
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
    input.attemptNo === 1 ? priceAction(input, context.priors, 1, 'immediate') : null,
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
    input.attemptNo > 3 ? null : priceAction(input, context.priors, input.attemptNo, 'next_day'),
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

    // Physics, not economics. Nothing recovers an expired card.
    if (isTerminal(input.reasonCode)) return null;

    // A budget the oracle also has to respect: a ceiling that could spend without limit
    // would not be a ceiling for a bounded system.
    if (input.attemptNo > 3) return null;

    let best: { readonly timing: Timing; readonly net: Paise } | null = null;

    for (const timing of TIMINGS) {
      const rail = timing === 'alt_rail' ? 'upi_intent' : input.currentRail;
      const pBps = truth.model.successProbability(
        input.reasonCode,
        input.attemptNo,
        timing,
        truth.issuerId,
      );
      if (pBps === 0) continue;

      const verdict = evGate({
        amount: input.amount,
        marginBps: input.marginBps,
        pBps,
        gatewayFee: input.policy.gatewayFee(rail),
        messageCost: ZERO,
        llmCost: ZERO,
        // Fires on any positive expected value. The policy's floor is a risk preference;
        // the ceiling is what a perfectly informed actor could extract.
        floor: ZERO,
      });

      if (verdict.kind !== 'pass') continue;
      if (best === null || verdict.arithmetic.net > best.net) {
        best = { timing, net: verdict.arithmetic.net };
      }
    }

    if (best === null) return null;

    const rail = best.timing === 'alt_rail' ? 'upi_intent' : input.currentRail;
    return {
      kind: 'fire',
      action: best.timing === 'alt_rail' ? 'switch_rail' : 'retry',
      rail,
      timing: best.timing,
      ev: evGate({
        amount: input.amount,
        marginBps: input.marginBps,
        pBps: truth.model.successProbability(
          input.reasonCode,
          input.attemptNo,
          best.timing,
          truth.issuerId,
        ),
        gatewayFee: input.policy.gatewayFee(rail),
        messageCost: ZERO,
        llmCost: ZERO,
        floor: ZERO,
      }).arithmetic,
      contact: {
        send: false,
        blockedBy: 'not_scheduled',
        detail: 'The oracle measures the recovery ceiling; it does not message customers.',
      },
    };
  },
};

export const ARMS: readonly Arm[] = [
  DO_NOTHING,
  RETRY_ALL_IMMEDIATELY,
  FIXED_SCHEDULE_DUNNING,
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
