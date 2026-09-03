import {
  ZERO,
  add,
  bps,
  hoursBetween,
  mulBps,
  paise,
  sub,
  type Bps,
  type Channel,
  type Paise,
  type ReasonCode,
  type TemplateId,
} from '@rc/core';
import type { Arm as ArmId } from '@rc/db';
import { priorKindFor, type ConsentState, type Policy, type PriorTable } from '@rc/policy';
import {
  DEFAULT_FEE_BUDGET_PER_TXN_PAISE,
  SIM_EPOCH,
  deriveRng,
  loadTruthModel,
  planAuthStream,
  planTxns,
  registeredTemplates,
  type PlannedCustomer,
  type PlannedTxn,
  type Rng,
  type TruthModel,
} from '@rc/simulator';
import { detect, signalsAffecting, type DegradationSignal } from '@rc/detect';
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
 * MESSAGING USED TO BE EXCLUDED HERE, and that exclusion is now gone. It was defensible
 * while every intervention was a charge: the truth model had no notion of a customer
 * responding to a nudge, so contact added cost and no recovery to every arm equally, and
 * omitting it kept the sweep about the retry policy. Roughly ₹0.42 of a ₹477 total.
 *
 * It stopped being defensible the moment four of the five risk classes recover money by
 * messaging and nothing else. Excluding contact would have made every checkout and every
 * receivable unrecoverable in the sweep, so the robustness check would have reported the
 * retry policy as the whole system while silently scoring most of it at zero. Messages are
 * therefore planned, priced and drawn against here, on the same truth table as everything
 * else.
 *
 * ONE MODELLING DECISION WORTH READING, because it moves the numbers. A recovered
 * subscription cycle is scored at `margin x remaining cycles`, not at one cycle's margin —
 * the same basis the expected-value gate priced it on. Scoring the decision on one basis and
 * its outcome on another would guarantee that every subscription action looked like a loss,
 * which is not a conservative choice but simply an incoherent one. The premise being
 * asserted is explicit: a saved subscription keeps paying. Cash collected this cycle is
 * reported separately in the run report, and the two are never added together.
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
const SWEEP_ARMS: readonly ArmId[] = ['b0', 'b1', 'b2', 'b4', 'rc'];

/**
 * Resolve a policy template id to the variant this customer would receive.
 *
 * Mirrors `loadTemplate` in `@rc/engine` without a database: same family-and-language lookup,
 * same English fallback when no variant exists, same rule that only a registered template may
 * be sent. The seed list is the single source both paths read, so the sweep cannot resolve a
 * template the persisted run would not.
 *
 * This replaced a single hardcoded "registered SMS template" handed to every arm. That
 * shortcut made every contact sendable, which meant the sweep could not see a voice
 * escalation, could not see a missing template, and reported the robustness of a system in
 * which messaging was always available.
 */
function resolveTemplate(
  id: string,
  language: 'en' | 'hi_latn',
): { readonly id: TemplateId; readonly channel: Channel; readonly registered: boolean } | null {
  const seeds = registeredTemplates();
  const named = seeds.find((seed) => seed.id === id);
  if (named === undefined) return null;

  const variant =
    language === 'en'
      ? named
      : (seeds.find(
          (seed) =>
            seed.family === named.family &&
            seed.channel === named.channel &&
            seed.language === language,
        ) ?? named);

  return {
    id: variant.id as TemplateId,
    channel: variant.channel,
    // Every seeded template is registered, by construction — `ensureTemplatesSeeded` writes
    // them with a DLT id and the schema refuses the alternative. Stated rather than assumed
    // so a future draft-status seed does not silently become sendable here.
    registered: true,
  };
}

/**
 * The consent state this customer has for the channel a step would use.
 *
 * `unknown` for a channel they never expressed a preference about, which is not `opt_in` —
 * the whole point of modelling it. Email is `unknown` throughout because the seeded book has
 * no email consent rows, exactly as the persisted run finds it.
 */
function consentFor(
  customer: PlannedCustomer,
  template: { readonly channel: Channel } | null,
): ConsentState {
  if (template === null) return 'unknown';
  if (template.channel === 'voice') return customer.voiceOptIn ? 'opt_in' : 'unknown';
  if (template.channel === 'sms') return customer.smsConsent ?? 'unknown';
  return 'unknown';
}

/** Rolling contact window, identical to `CONTACT_WINDOW_DAYS` in `@rc/engine`. */
const CONTACT_WINDOW_MS = 7 * 86_400_000;

/** Sends inside the rolling window ending at `now`, mirroring `countRecentContacts`. */
function countWithinWindow(sends: readonly Date[] | undefined, now: Date): number {
  if (sends === undefined) return 0;
  const since = now.getTime() - CONTACT_WINDOW_MS;
  return sends.filter((at) => at.getTime() >= since).length;
}

function record(ledger: Map<number, Date[]>, key: number, at: Date): void {
  const existing = ledger.get(key);
  if (existing === undefined) ledger.set(key, [at]);
  else existing.push(at);
}

/** Whether a live e-mandate backs this transaction, mirroring `loadTxnContext`. */
function mandateBacked(txn: PlannedTxn): boolean {
  return txn.isRecurring && txn.riskClass !== 'mandate_lapsed';
}

/** Multiply a paise amount by a whole cycle count. */
function mulCycles(amount: Paise, cycles: number): Paise {
  return (amount * BigInt(cycles)) as Paise;
}

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
  const { txns, customers, customerIssuers } = planTxns(options.seed, options.count);

  // The detector's conclusions, so this path refuses exactly what the database runner
  // refuses. Without it the two diverged by 26 attempts, which the parity test caught.
  //
  // COMPUTED ONCE PER SEED AND CACHED ACROSS WORLDS. A sweep runs 500 perturbed worlds, and
  // the perturbation moves the truth table's success probabilities — it does not touch the
  // authorisation stream or the outage episodes, which are properties of the environment
  // rather than of our beliefs about it. Re-detecting per world would repeat identical work
  // 500 times over a 14,000-row stream and add minutes to the sweep for no change in result.
  //
  // Guarded on the arm for the same reason the runner guards it: only the controller acts on
  // detection, because giving the baselines outage awareness would flatter them into a
  // comparison nobody runs.
  const signals = options.arm.id === 'rc' ? signalsForSeed(options.seed) : [];

  let valueRecovered = ZERO;
  let cost = ZERO;
  let recovered = 0;
  let fired = 0;

  // The identical ceiling `generateBatch` writes, from the same exported constant.
  let feeRemaining = paise(BigInt(DEFAULT_FEE_BUDGET_PER_TXN_PAISE * options.count));

  // PER CUSTOMER and TIME-WINDOWED, because the real ceiling is both. With 1.6 failures per
  // customer, a per-transaction counter would let one customer receive two messages about
  // each of three invoices and call it three separate weeks — the loophole the ceiling exists
  // to close. Send instants rather than counts, so the rolling seven-day window can be
  // applied exactly as `countRecentContacts` applies it.
  const sendsByCustomer = new Map<number, Date[]>();
  const callsSentByCustomer = new Map<number, Date[]>();

  // IN THE SAME ORDER THE DATABASE RUNNER PROCESSES THEM: by failure time, tie-broken on the
  // generation index. Iterating in generation order was harmless while transactions were
  // independent, and became a real divergence once the contact ceiling coupled the ones
  // belonging to a single customer — the two paths disagreed by one attempt in two hundred.
  const ordered = [...txns.entries()].sort(
    ([leftIndex, left], [rightIndex, right]) =>
      left.failedAt.getTime() - right.failedAt.getTime() || leftIndex - rightIndex,
  );

  for (const [index, txn] of ordered) {
    const issuerId = customerIssuers[txn.customerIndex];
    const customer = customers[txn.customerIndex];
    if (customer === undefined) throw new Error('unreachable: customer index out of range');
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
    let noticeSentAt: Date | null = null;

    for (let step = 0; step < 6; step += 1) {
      // The step's own template, resolved exactly as `loadPlanContext` resolves it: the
      // step's override wins over the reason code's default, and the language variant is
      // selected for this customer. Resolved BEFORE the landing time, because a voice
      // template changes the landing — a call has to fall inside the permitted window.
      const scheduledStep = policy.scheduleEntry(believedCode, attemptNo, txn.riskClass);
      const templateId =
        scheduledStep?.template ?? policy.forReason(believedCode, txn.riskClass).template;
      const template =
        templateId === undefined ? null : resolveTemplate(templateId, customer.language);

      // Identical scheduling to the database runner, from the same helper. A sweep that
      // scheduled attempts differently would be measuring a different system.
      const landsAt = attemptLandsAt({
        policy,
        reasonCode: believedCode,
        riskClass: txn.riskClass,
        attemptNo,
        failedAt: txn.failedAt,
        previousLanding,
        fallback: clock,
        promiseDueAt: txn.promise?.promisedFor ?? null,
        ...(template === null ? {} : { channel: template.channel }),
      });
      clock = landsAt;

      const plan = arm.plan(
        {
          now: clock,
          policy,
          priors,
          reasonCode: believedCode,
          riskClass: txn.riskClass,
          amount: paise(BigInt(txn.amountPaise)),
          marginBps: bps(txn.marginBps),
          lifetimeCycles: txn.lifetimeCycles,
          currentRail: txn.rail,
          attemptNo,
          hoursSinceLastAttempt: gapSinceLastAttempt(previousLanding, landsAt),
          contactsThisWeek: countWithinWindow(sendsByCustomer.get(txn.customerIndex), landsAt),
          callsThisWeek: countWithinWindow(callsSentByCustomer.get(txn.customerIndex), landsAt),
          // The customer's REAL consent, from the same planned population the persisted run
          // writes. The sweep used to hand every arm `opt_in` and a universal template,
          // which measured the robustness of a system in which nobody had opted out.
          consent: consentFor(customer, template),
          template,
          onNcprRegistry: customer.onNcprRegistry,
          mandateBacked: mandateBacked(txn),
          hoursSincePreDebitNotice:
            noticeSentAt === null ? null : hoursBetween(noticeSentAt, landsAt),
          openPromiseDueAt:
            txn.promise?.status === 'open' ? txn.promise.promisedFor : null,
          batchFeeRemaining: feeRemaining,
          // At `clock`, matching the runner: the population's verdict at the moment the
          // engine decides, not at the moment the payment failed.
          cohortRisk: signalsAffecting(signals, {
            issuerId,
            rail: txn.rail,
            at: clock,
          }),
        },
        { priors, truth: { model: truth, issuerId } },
      );

      if (plan === null) break;

      // A REFUSAL CAN STILL SEND, and forgetting that cost the parity test 126 paise —
      // exactly seven SMS. An escalation is a contact with no attempt: the policy hands a
      // terminal cause to a human and tells the customer, which the persisted path records
      // and charges. The sweep broke out of the loop before charging it, so it ran seven
      // messages cheaper than the run it claims to reproduce.
      if (plan.kind !== 'fire') {
        if (plan.contact.send) {
          cost = add(cost, policy.messageCost(plan.contact.channel));
          record(sendsByCustomer, txn.customerIndex, landsAt);
          if (plan.contact.channel === 'voice') record(callsSentByCustomer, txn.customerIndex, landsAt);
        }
        break;
      }

      const kind = priorKindFor(plan.action);
      const fee = kind === 'charge' ? policy.gatewayFee(plan.rail) : ZERO;
      if (fee > feeRemaining) break;

      feeRemaining = sub(feeRemaining, fee);

      // Gateway fees AND message costs. The amortised model cost still enters the
      // EXPECTED-value arithmetic — the policy is right to budget for it when deciding — but
      // it is not a realised cost here, because the sweep runs on true causes with no
      // classifier in the loop. Charging it would put the sweep ₹0.04 an attempt below the
      // run it is meant to reproduce, for a model call that never happened.
      cost = add(cost, fee);
      if (plan.contact.send) {
        cost = add(cost, policy.messageCost(plan.contact.channel));
        // Both ledgers record a call: a call is a contact as well as a call, so the general
        // weekly ceiling still binds. Recording it only against the voice ceiling would let
        // one call plus two messages through a limit of two.
        record(sendsByCustomer, txn.customerIndex, landsAt);
        if (plan.contact.channel === 'voice') {
          record(callsSentByCustomer, txn.customerIndex, landsAt);
        }
      }
      fired += 1;

      // A pre-debit notice matures for the rest of this transaction's sequence. Tracked here
      // rather than read back, because the sweep has no `message_send` table — and without
      // it every mandate-backed retry after the notice would refuse itself with
      // `pre_debit_notice`, silently zeroing the whole subscription class.
      //
      // Conditional on the message actually being SENT, exactly as the persisted path is: a
      // notice suppressed by consent or quiet hours never reached the customer, so the debit
      // that follows it is still unlawful.
      if (plan.action === 'pre_debit_notify' && plan.contact.send) {
        noticeSentAt = landsAt;
      }

      // Keyed on the world and the specific attempt, so a draw's outcomes are reproducible
      // and independent of the order arms happen to run in.
      // The identical derivation the real gateway uses: the transaction's world-independent
      // position, its attempt number, and the timing chosen.
      //
      // Two consequences, both wanted. The shipped-truth sweep reproduces the persisted run
      // exactly — asserted by a test. And every world faces the SAME coin flips, so a
      // difference between worlds is attributable to the world rather than to luck, which
      // is the question a sensitivity analysis is asking.
      const rng = deriveRng(options.seed, `${index}:${attemptNo}:${plan.timing}:${kind}`);

      // The TRUE cause, always. The world does not care what the classifier decided — an
      // attempt timed for a salary window against a payment that actually failed on a
      // revoked mandate still meets the revoked mandate.
      const success = truth.attemptSucceeds(
        rng,
        txn.trueCode,
        attemptNo,
        plan.timing,
        issuerId,
        kind,
      );

      if (success) {
        // Scored on the SAME basis the decision was priced on. See the module header: using
        // one cycle here and six in the gate would make every subscription action look like
        // a loss by construction.
        const cycles = txn.lifetimeCycles ?? 1;
        valueRecovered = add(
          valueRecovered,
          mulCycles(mulBps(paise(BigInt(txn.amountPaise)), bps(txn.marginBps)), cycles),
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

/**
 * Detection over a seed's authorisation stream, memoised.
 *
 * Keyed on the seed alone, because that is everything the stream depends on: the episodes
 * come from `priors.truth.yaml` and the traffic from a derived RNG. A sweep therefore pays
 * for detection once rather than five hundred times.
 *
 * Deliberately a module-level cache rather than a parameter threaded through `simulateArm`.
 * The alternative is every caller — the sweep CLI, the parity test, the frontier scan —
 * having to know that detection is expensive and arrange to share it, which is exactly the
 * kind of knowledge that gets forgotten in one of three places.
 */
const signalCache = new Map<number, readonly DegradationSignal[]>();

function signalsForSeed(seed: number): readonly DegradationSignal[] {
  const cached = signalCache.get(seed);
  if (cached !== undefined) return cached;

  const truth = loadTruthModel();
  const stream = planAuthStream(seed, SIM_EPOCH, truth.issuers, truth.outages).map((attempt) => ({
    issuerId: attempt.issuerId,
    rail: attempt.rail,
    binBucket: attempt.binBucket,
    succeeded: attempt.succeeded,
    reasonCode: attempt.reasonCode,
    occurredAt: attempt.occurredAt,
  }));

  const signals = detect(stream);
  signalCache.set(seed, signals);
  return signals;
}
