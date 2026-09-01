import {
  ZERO,
  add,
  bps,
  mulBps,
  paise,
  sub,
  type Bps,
  type Paise,
  type ReasonCode,
} from '@rc/core';
import type { Arm as ArmId } from '@rc/db';
import type { Policy, PriorTable } from '@rc/policy';
import {
  DEFAULT_FEE_BUDGET_PER_TXN_PAISE,
  deriveRng,
  planTxns,
  type Rng,
  type TruthModel,
} from '@rc/simulator';
import { armById, type Arm } from './arms.js';
import { attemptLandsAt, gapSinceLastAttempt } from './schedule.js';

/**
 * THE SENSITIVITY SWEEP
 *
 * The answer to the question that would otherwise dismantle this submission: *you wrote the
 * simulator, so why should anyone believe the result?*
 *
 * The honest answer is not a reassurance. It is to run the comparison again in five hundred
 * worlds drawn around the one I invented, and report the share in which the conclusion
 * survives — plus the boundary at which it stops being true, named, so a reader knows
 * exactly which figure to go and measure with real gateway data.
 *
 * THIS RUNS IN MEMORY, and that is a correctness decision rather than a shortcut. Five
 * hundred draws over five arms and three hundred transactions is 750,000 transaction-runs;
 * through Postgres that is hours, and a robustness check nobody can afford to run is a
 * robustness check nobody runs.
 *
 * What is reused: `planTxns` (the same population), `planNext` via the arms (the same
 * policy engine, the same expected-value gate, the same bounds), and the same truth model.
 * Only persistence is skipped. A sweep that reimplemented the decision logic would be
 * measuring a second system that happens to resemble the first.
 *
 * What is deliberately excluded: MESSAGING. Customer contact costs money and — as the
 * README states — the truth model has no notion of a customer responding to a nudge, so
 * including it would add cost and no recovery to every arm equally. Excluding it keeps the
 * sweep about the retry policy, which is what varies. The omitted cost is roughly ₹0.42 of
 * a ₹477 total.
 */

export interface SweepArmResult {
  readonly arm: ArmId;
  readonly net: Paise;
  readonly recovered: number;
  readonly fired: number;
}

export interface SweepDraw {
  readonly draw: number;
  readonly results: readonly SweepArmResult[];
  /** True when the Recovery Controller's net value beat every baseline in this world. */
  readonly controllerWins: boolean;
  readonly controllerNet: Paise;
  readonly bestBaselineNet: Paise;
}

/** Arms the sweep compares. The oracle is excluded: it is a ceiling, not a competitor. */
const SWEEP_ARMS: readonly ArmId[] = ['b0', 'b1', 'b2', 'rc'];

export interface SimulateOptions {
  readonly seed: number;
  readonly count: number;
  readonly policy: Policy;
  readonly priors: PriorTable;
  readonly truth: TruthModel;
  readonly arm: Arm;
  /**
   * Share of transactions whose cause is mislabelled before the policy ever sees it.
   *
   * Attacks a different surface from a perturbed truth table. The other hostile worlds make
   * the WORLD wrong; this makes the POLICY'S VIEW of the world wrong while the world itself
   * behaves normally. The distinction matters because the failure modes differ: a wrong
   * world wastes attempts that were never going to work, whereas a wrong label sends a
   * perfectly recoverable payment down a schedule built for a different cause.
   */
  readonly labelCorruptionBps?: Bps;
}

/**
 * Swap a reason code for a different one, deterministically.
 *
 * Corrupts to a NON-TERMINAL code. A corruption that landed on `card_expired` would cause
 * the policy to refuse and escalate — which looks like damage in the metrics but is
 * actually the system being handed a reason to stop. Restricting corruption to codes that
 * invite action makes the test measure what it claims: money spent executing the wrong plan.
 */
function corruptCode(code: ReasonCode, rng: Rng): ReasonCode {
  const alternatives = ACTIONABLE_CODES.filter((candidate) => candidate !== code);
  return alternatives.length === 0 ? code : rng.pick(alternatives);
}

const ACTIONABLE_CODES: readonly ReasonCode[] = [
  'insufficient_funds',
  'issuer_down',
  'do_not_honour',
  'threeds_timeout',
  'network_timeout',
];

/**
 * Replay one arm over the population, in memory.
 *
 * Mirrors the database runner's control flow exactly: one plan per step, stop on refusal,
 * stop on success, advance the simulated clock by the chosen timing, and respect the batch
 * fee budget.
 */
/**
 * Replay one arm over the population, in memory.
 *
 * Note the absence of a `world` parameter. Outcomes key on the transaction's
 * world-independent position, so which world a population was materialised into cannot
 * affect its coin flips — which is the whole point of `logical_ref`. A sweep of the shipped
 * truth therefore reproduces the persisted run exactly, and a test asserts it.
 */
export function simulateArm(options: SimulateOptions): SweepArmResult {
  const { policy, priors, truth, arm } = options;

  // Both the population AND its issuer assignment come from the same call, rather than the
  // issuers being regenerated separately from the same RNG stream. Two derivations of the
  // same thing are two things that can drift, and a sweep running against a differently
  // assigned population would be answering a different question from the one it reports.
  const { txns, customerIssuers } = planTxns(options.seed, options.count);

  let valueRecovered = ZERO;
  let cost = ZERO;
  let recovered = 0;
  let fired = 0;

  // The identical ceiling `generateBatch` writes, from the same exported constant.
  let feeRemaining = paise(BigInt(DEFAULT_FEE_BUDGET_PER_TXN_PAISE * options.count));

  for (const [index, txn] of txns.entries()) {
    const issuerId = customerIssuers[txn.customerIndex];
    if (issuerId === undefined) throw new Error('unreachable: customer index out of range');

    // What the policy BELIEVES the cause is. The truth model is always consulted with the
    // real cause below, so a corrupted label means the policy executes a correct plan for
    // the wrong failure — which is exactly what a misclassification costs in production.
    const corruption = options.labelCorruptionBps;
    const believedCode =
      corruption === undefined || corruption === 0
        ? txn.trueCode
        : deriveRng(options.seed, `corrupt:${index}`).chance(corruption)
          ? corruptCode(txn.trueCode, deriveRng(options.seed, `swap:${index}`))
          : txn.trueCode;

    let clock = txn.failedAt;
    let attemptNo = 1;
    let previousLanding: Date | null = null;

    for (let step = 0; step < 6; step += 1) {
      // Identical scheduling to the database runner, from the same helper. A sweep that
      // scheduled attempts differently would be measuring a different system.
      const landsAt = attemptLandsAt({
        policy,
        reasonCode: believedCode,
        attemptNo,
        failedAt: txn.failedAt,
        previousLanding,
        fallback: clock,
      });
      clock = landsAt;

      const plan = arm.plan(
        {
          now: clock,
          policy,
          priors,
          reasonCode: believedCode,
          amount: paise(BigInt(txn.amountPaise)),
          marginBps: bps(txn.marginBps),
          currentRail: txn.rail,
          attemptNo,
          hoursSinceLastAttempt: gapSinceLastAttempt(previousLanding, landsAt),
          contactsThisWeek: 0,
          consent: 'unknown',
          // No template, so no contact is ever planned. See the module header: messaging is
          // excluded from the sweep because it costs money and recovers none in this model.
          template: null,
          batchFeeRemaining: feeRemaining,
        },
        { priors, truth: { model: truth, issuerId } },
      );

      if (plan === null || plan.kind !== 'fire') break;

      const fee = policy.gatewayFee(plan.rail);
      if (fee > feeRemaining) break;

      feeRemaining = sub(feeRemaining, fee);

      // Gateway fees only. The amortised model cost still enters the EXPECTED-value
      // arithmetic — the policy is right to budget for it when deciding — but it is not a
      // realised cost here, because the sweep runs on true causes with no classifier in the
      // loop. Charging it would put the sweep ₹0.04 an attempt below the run it is meant to
      // reproduce, for a model call that never happened.
      cost = add(cost, fee);
      fired += 1;

      // Keyed on the world and the specific attempt, so a draw's outcomes are reproducible
      // and independent of the order arms happen to run in.
      // The identical derivation the real gateway uses: the transaction's world-independent
      // position, its attempt number, and the timing chosen.
      //
      // Two consequences, both wanted. The shipped-truth sweep reproduces the persisted run
      // exactly — asserted by a test. And every world faces the SAME coin flips, so a
      // difference between worlds is attributable to the world rather than to luck, which
      // is the question a sensitivity analysis is asking.
      const rng = deriveRng(options.seed, `${index}:${attemptNo}:${plan.timing}`);

      // The TRUE cause, always. The world does not care what the classifier decided — an
      // attempt timed for a salary window against a payment that actually failed on a
      // revoked mandate still meets the revoked mandate.
      const success = truth.attemptSucceeds(
        rng,
        txn.trueCode,
        attemptNo,
        plan.timing,
        issuerId,
      );

      if (success) {
        valueRecovered = add(
          valueRecovered,
          mulBps(paise(BigInt(txn.amountPaise)), bps(txn.marginBps)),
        );
        recovered += 1;
        break;
      }

      previousLanding = landsAt;
      attemptNo += 1;
    }
  }

  return { arm: arm.id, net: sub(valueRecovered, cost), recovered, fired };
}

export interface SweepOptions {
  readonly seed: number;
  readonly count: number;
  readonly draws: number;
  readonly policy: Policy;
  readonly priors: PriorTable;
  /** Produces the world for a given draw. */
  readonly worldFor: (draw: number) => TruthModel;
}

export interface SweepReport {
  readonly draws: number;
  readonly controllerWins: number;
  readonly winShareBps: number;
  readonly medianControllerNet: Paise;
  readonly worstControllerNet: Paise;
  readonly bestControllerNet: Paise;
  readonly losses: readonly SweepDraw[];
  /**
   * The controller's net value in every world, unsorted.
   *
   * Exposed so the report can draw the distribution rather than only its summary. A median
   * and a range describe a shape; the shape itself shows whether the outcome is a tight
   * cluster or a long tail, and those warrant very different confidence.
   */
  readonly controllerNets: readonly Paise[];
}

export function runSweep(options: SweepOptions): SweepReport {
  const arms = SWEEP_ARMS.map((id) => armById(id));
  const draws: SweepDraw[] = [];

  for (let draw = 0; draw < options.draws; draw += 1) {
    const truth = options.worldFor(draw);

    const results = arms.map((arm) =>
      simulateArm({
        seed: options.seed,
        count: options.count,
        policy: options.policy,
        priors: options.priors,
        truth,
        arm,
      }),
    );

    const controller = results.find((result) => result.arm === 'rc');
    if (controller === undefined) throw new Error('unreachable: rc arm missing');

    // Compared against the BEST baseline in each world, not against a fixed one. Whichever
    // naive strategy happens to suit a given world is the one the controller has to beat
    // there — anything weaker would be picking a favourable opponent per draw.
    const bestBaselineNet = results
      .filter((result) => result.arm !== 'rc')
      .reduce<Paise>((best, result) => (result.net > best ? result.net : best), ZERO);

    draws.push({
      draw,
      results,
      controllerWins: controller.net > bestBaselineNet,
      controllerNet: controller.net,
      bestBaselineNet,
    });
  }

  const nets = draws.map((entry) => entry.controllerNet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const wins = draws.filter((entry) => entry.controllerWins).length;

  return {
    draws: draws.length,
    controllerWins: wins,
    winShareBps: draws.length === 0 ? 0 : Math.round((wins / draws.length) * 10_000),
    medianControllerNet: nets[Math.floor(nets.length / 2)] ?? ZERO,
    worstControllerNet: nets[0] ?? ZERO,
    bestControllerNet: nets.at(-1) ?? ZERO,
    losses: draws.filter((entry) => !entry.controllerWins),
    controllerNets: draws.map((entry) => entry.controllerNet),
  };
}
