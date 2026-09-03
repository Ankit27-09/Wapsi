import {
  PaiseSchema,
  RISK_CLASSES,
  ZERO,
  add,
  bps,
  mulBps,
  sub,
  type Paise,
  type RiskClass,
} from '@rc/core';
import type { Arm as ArmId, Db } from '@rc/db';
import { type PriorTable } from '@rc/policy';

/**
 * METRICS
 *
 * Aggregated in TypeScript rather than in SQL, and the reason is rounding.
 *
 * `value_recovered` is `recovered × margin_bps`, and Postgres bigint division truncates
 * while `mulBps` rounds half away from zero. Computing the headline figure with different
 * arithmetic from the gate that decided the action would mean the reported total quietly
 * disagreeing with the decisions that produced it — by a paise per row, which on a batch
 * of a few hundred is exactly the kind of discrepancy someone notices on stage.
 *
 * One rounding implementation, used everywhere. The cost is fetching a few hundred rows
 * per arm, which is nothing.
 */

export interface ArmMetrics {
  readonly arm: ArmId;

  readonly transactions: number;
  /**
   * Transactions whose cause has a non-zero published prior.
   *
   * The denominator for recovery rate. Using the total instead would flatter every arm
   * equally by counting expired cards and revoked mandates as missed opportunities — and
   * would make the metric depend on the batch's mix of unrecoverable failures rather than
   * on the strategy.
   */
  readonly recoverable: number;
  readonly recovered: number;
  readonly recoveryRateBps: number;

  /** Face value of the payments recovered. */
  readonly grossRecovered: Paise;
  /** What the merchant actually gains: contribution margin on the recovered payments. */
  readonly valueRecovered: Paise;

  readonly gatewayFees: Paise;
  readonly messageCosts: Paise;
  readonly modelCosts: Paise;
  readonly cost: Paise;

  /** `valueRecovered − cost`. The headline. */
  readonly net: Paise;
  /** Reported alongside `net` and clearly labelled, never instead of it. */
  readonly grossNet: Paise;

  readonly attemptsFired: number;
  /**
   * Attempts fired whose expected value, priced against the PUBLISHED priors, was negative.
   *
   * Zero for Wapsi by construction — the gate refuses them. For a
   * baseline it is the size of the waste, measured against the policy's own beliefs rather
   * than against hindsight, which is what makes it a fair criticism instead of a gotcha.
   */
  readonly negativeEvAttempts: number;
  readonly negativeEvSpend: Paise;

  readonly refusalsByVerdict: Readonly<Record<string, number>>;
  readonly contactsSent: number;

  /**
   * Contribution margin on the FUTURE cycles a recovered subscription keeps alive.
   *
   * Reported as its own line and never folded into `valueRecovered`, because the two rest on
   * different footings. `valueRecovered` is margin on money that has actually moved. This is
   * margin on money that will move only if the saved subscription runs its expected term —
   * a modelling assumption, stated as one.
   *
   * It is not decoration: the expected-value gate PRICES on this basis, which is why the
   * engine spends more chasing a ₹499 cycle than a ₹499 one-off. Showing what the gate
   * believed it was buying, next to the cash it actually collected, is the only way a reader
   * can judge whether the extra spend was justified.
   */
  readonly lifetimeValuePreserved: Paise;

  /** Per-risk-class breakdown. The proof that each domain works, rather than the average. */
  readonly byRiskClass: readonly RiskClassMetrics[];

  /**
   * Expected recovery given up to each bound, in rupees.
   *
   * THE PRICE OF THE GUARDRAILS, and the honest answer to why the controller sits below the
   * ceiling on the messaging classes. The oracle assumes every customer is reachable; the
   * controller asks for consent, keeps quiet hours, and stops at a weekly ceiling. Those cost
   * money, the amount is knowable, and leaving it as an unexplained shortfall would invite
   * the reader to assume the strategy is weak when the constraint is doing its job.
   *
   * Valued at `value x p` — what the refused action was expected to recover — rather than at
   * the amount at risk, which would count the same rupees once per refused attempt.
   *
   * This is a number to state, not to optimise against. A bound that costs money and exists
   * for a legal reason is correct, and knowing its price is what makes it a decision.
   */
  readonly forgoneByRule: readonly {
    readonly rule: string;
    readonly count: number;
    readonly forgone: Paise;
  }[];
}

/**
 * One risk class's slice of an arm's results.
 *
 * The reason this exists: a single blended net figure cannot distinguish "works everywhere"
 * from "works brilliantly on payments and loses money on receivables". Five classes share one
 * engine, so the aggregate is exactly where a per-class failure would hide — and a reader
 * being asked to believe the engine generalises is entitled to see it per domain.
 */
export interface RiskClassMetrics {
  readonly riskClass: RiskClass;
  readonly transactions: number;
  readonly recoverable: number;
  readonly recovered: number;
  readonly valueRecovered: Paise;
  readonly cost: Paise;
  readonly net: Paise;
  readonly attemptsFired: number;
  readonly refused: number;
}

export async function computeMetrics(
  db: Db,
  args: {
    readonly seed: number;
    readonly arm: ArmId;
    readonly world?: string;
    readonly priors: PriorTable;
  },
): Promise<ArmMetrics> {
  const world = args.world ?? 'base';

  const batch = await db
    .selectFrom('batch')
    .select('id')
    .where('seed', '=', args.seed)
    .where('arm', '=', args.arm)
    .where('world', '=', world)
    .executeTakeFirstOrThrow(
      () => new Error(`No batch for seed ${args.seed}, arm ${args.arm}, world "${world}"`),
    );

  // ---- the population -----------------------------------------------------
  const txns = await db
    .selectFrom('txn')
    .innerJoin('failure_event', 'failure_event.txn_id', 'txn.id')
    .select([
      'txn.id as id',
      'txn.margin_bps as margin_bps',
      'txn.risk_class as risk_class',
      'txn.lifetime_cycles as lifetime_cycles',
      'failure_event.raw as raw',
    ])
    .where('txn.batch_id', '=', batch.id)
    .execute();

  interface TxnFacts {
    readonly marginBps: number;
    readonly riskClass: RiskClass;
    readonly lifetimeCycles: number | null;
  }

  const factsByTxn = new Map<string, TxnFacts>();
  let recoverable = 0;

  // Per-class accumulators, initialised for every class so a class with no transactions
  // reports zeroes rather than vanishing from the table. An absent row reads as "not
  // implemented"; a zero row reads as "nothing to do", and they are different claims.
  const classAcc = new Map<
    RiskClass,
    {
      transactions: number;
      recoverable: number;
      recovered: number;
      valueRecovered: Paise;
      cost: Paise;
      attemptsFired: number;
      refused: number;
    }
  >(
    RISK_CLASSES.map((riskClass) => [
      riskClass,
      {
        transactions: 0,
        recoverable: 0,
        recovered: 0,
        valueRecovered: ZERO,
        cost: ZERO,
        attemptsFired: 0,
        refused: 0,
      },
    ]),
  );

  for (const txn of txns) {
    factsByTxn.set(txn.id, {
      marginBps: txn.margin_bps,
      riskClass: txn.risk_class,
      lifetimeCycles: txn.lifetime_cycles,
    });

    const slice = classAcc.get(txn.risk_class);
    if (slice === undefined) throw new Error(`Unknown risk class ${txn.risk_class}`);
    slice.transactions += 1;

    if (hasNonZeroPrior(args.priors, trueCodeOf(txn.raw))) {
      recoverable += 1;
      slice.recoverable += 1;
    }
  }

  // ---- what happened ------------------------------------------------------
  // Message costs are joined in here rather than summed separately, because a decision's
  // waste is its fee PLUS its message. Summing them apart is what made a baseline that
  // spends nothing on fees and 511 messages report ₹0.00 of negative-expected-value spend —
  // a figure that flattered the very arm the comparison exists to hold to account.
  const sendCostByDecision = new Map<string, Paise>();
  const messages = await db
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .select([
      'message_send.decision_id as decision_id',
      'message_send.cost_paise as cost_paise',
      'decision.txn_id as txn_id',
    ])
    .where('decision.batch_id', '=', batch.id)
    .execute();

  let messageCosts = ZERO;
  for (const row of messages) {
    const cost = PaiseSchema.parse(row.cost_paise);
    messageCosts = add(messageCosts, cost);
    sendCostByDecision.set(
      row.decision_id,
      add(sendCostByDecision.get(row.decision_id) ?? ZERO, cost),
    );
    addClassCost(classAcc, factsByTxn, row.txn_id, cost);
  }

  const outcomes = await db
    .selectFrom('outcome')
    .innerJoin('decision', 'decision.id', 'outcome.decision_id')
    .select([
      'decision.id as decision_id',
      'decision.txn_id as txn_id',
      'decision.ev_net_paise as ev_net_paise',
      'outcome.success as success',
      'outcome.fee_paise as fee_paise',
      'outcome.recovered_paise as recovered_paise',
    ])
    .where('decision.batch_id', '=', batch.id)
    .execute();

  let grossRecovered = ZERO;
  let valueRecovered = ZERO;
  let lifetimeValuePreserved = ZERO;
  let gatewayFees = ZERO;
  let negativeEvSpend = ZERO;
  let negativeEvAttempts = 0;
  const recoveredTxns = new Set<string>();

  for (const row of outcomes) {
    const fee = PaiseSchema.parse(row.fee_paise);
    gatewayFees = add(gatewayFees, fee);
    addClassCost(classAcc, factsByTxn, row.txn_id, fee);

    if (PaiseSchema.parse(row.ev_net_paise) < ZERO) {
      negativeEvAttempts += 1;
      negativeEvSpend = add(
        negativeEvSpend,
        add(fee, sendCostByDecision.get(row.decision_id) ?? ZERO),
      );
    }

    if (!row.success) continue;

    const recovered = PaiseSchema.parse(row.recovered_paise);
    const facts = factsByTxn.get(row.txn_id);
    if (facts === undefined) throw new Error(`Outcome for unknown txn ${row.txn_id}`);

    const margin = mulBps(recovered, bps(facts.marginBps));

    grossRecovered = add(grossRecovered, recovered);
    valueRecovered = add(valueRecovered, margin);
    recoveredTxns.add(row.txn_id);

    const slice = classAcc.get(facts.riskClass);
    if (slice !== undefined) {
      slice.recovered += 1;
      slice.valueRecovered = add(slice.valueRecovered, margin);
    }

    // The cycles BEYOND this one. `lifetime_cycles` counts the remaining term including the
    // cycle just recovered, whose margin is already in `valueRecovered` — adding it again
    // here would double-count the only cash that actually moved.
    if (facts.lifetimeCycles !== null && facts.lifetimeCycles > 1) {
      lifetimeValuePreserved = add(
        lifetimeValuePreserved,
        (margin * BigInt(facts.lifetimeCycles - 1)) as Paise,
      );
    }
  }

  const modelCalls = await db
    .selectFrom('llm_call')
    .select(['cost_paise'])
    .where('batch_id', '=', batch.id)
    .execute();

  const modelCosts = modelCalls.reduce(
    (total, row) => add(total, PaiseSchema.parse(row.cost_paise)),
    ZERO,
  );

  // ---- decisions ----------------------------------------------------------
  const decisions = await db
    .selectFrom('decision')
    .select([
      'verdict',
      'txn_id',
      'refuse_rule',
      'ev_p_bps',
      'ev_value_paise',
    ])
    .where('batch_id', '=', batch.id)
    .execute();

  const refusalsByVerdict: Record<string, number> = {};
  const forgone = new Map<string, { count: number; forgone: Paise }>();
  let attemptsFired = 0;

  for (const row of decisions) {
    const slice = classAcc.get(factsByTxn.get(row.txn_id)?.riskClass ?? 'payment_failure');
    if (row.verdict === 'fire') {
      attemptsFired += 1;
      if (slice !== undefined) slice.attemptsFired += 1;
      continue;
    }

    refusalsByVerdict[row.verdict] = (refusalsByVerdict[row.verdict] ?? 0) + 1;
    if (slice !== undefined) slice.refused += 1;

    // `refuse_rule` is non-null for every refusal, enforced by a CHECK — but rows written
    // before migration 012 would have null, so this reads defensively rather than asserting.
    const rule = row.refuse_rule ?? 'unrecorded';
    const entry = forgone.get(rule) ?? { count: 0, forgone: ZERO };
    entry.count += 1;
    entry.forgone = add(
      entry.forgone,
      mulBps(PaiseSchema.parse(row.ev_value_paise), bps(row.ev_p_bps)),
    );
    forgone.set(rule, entry);
  }

  const cost = add(add(gatewayFees, messageCosts), modelCosts);

  return {
    arm: args.arm,
    transactions: txns.length,
    recoverable,
    recovered: recoveredTxns.size,
    recoveryRateBps:
      recoverable === 0 ? 0 : Math.round((recoveredTxns.size / recoverable) * 10_000),
    grossRecovered,
    valueRecovered,
    gatewayFees,
    messageCosts,
    modelCosts,
    cost,
    net: sub(valueRecovered, cost),
    grossNet: sub(grossRecovered, cost),
    attemptsFired,
    negativeEvAttempts,
    negativeEvSpend,
    refusalsByVerdict,
    contactsSent: messages.length,
    lifetimeValuePreserved,
    forgoneByRule: [...forgone.entries()]
      .map(([rule, value]) => ({ rule, ...value }))
      .sort((a, b) => (b.forgone > a.forgone ? 1 : b.forgone < a.forgone ? -1 : 0)),
    byRiskClass: RISK_CLASSES.map((riskClass) => {
      const slice = classAcc.get(riskClass);
      if (slice === undefined) throw new Error(`unreachable: no accumulator for ${riskClass}`);
      return {
        riskClass,
        transactions: slice.transactions,
        recoverable: slice.recoverable,
        recovered: slice.recovered,
        valueRecovered: slice.valueRecovered,
        cost: slice.cost,
        net: sub(slice.valueRecovered, slice.cost),
        attemptsFired: slice.attemptsFired,
        refused: slice.refused,
      };
    }),
  };
}

/**
 * Attribute one rupee of spend to the risk class of the transaction that incurred it.
 *
 * The model cost is deliberately NOT attributed. It is amortised per decision rather than
 * measured per decision, so splitting it across classes would invent a precision the figure
 * does not have — the per-class costs are therefore fees plus messages, and the aggregate
 * `cost` remains the only line that includes model spend.
 */
function addClassCost(
  acc: Map<RiskClass, { cost: Paise }>,
  facts: ReadonlyMap<string, { readonly riskClass: RiskClass }>,
  txnId: string,
  amount: Paise,
): void {
  const riskClass = facts.get(txnId)?.riskClass;
  if (riskClass === undefined) return;
  const slice = acc.get(riskClass);
  if (slice !== undefined) slice.cost = add(slice.cost, amount);
}

function trueCodeOf(raw: unknown): string {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const simulator = (parsed as { simulator?: { true_reason_code?: unknown } } | null)
    ?.simulator;
  const code = simulator?.true_reason_code;
  if (typeof code !== 'string') {
    throw new Error('failure_event.raw does not carry a seeded true_reason_code');
  }
  return code;
}

/**
 * Whether the published evidence offers any path to recovering this cause.
 *
 * Notably this uses the POLICY's priors, not the simulator's truth. A transaction counts
 * as recoverable if the published evidence says something could work — which is the
 * information any real merchant would have, and keeps the denominator honest rather than
 * clairvoyant.
 */
function hasNonZeroPrior(priors: PriorTable, code: string): boolean {
  return priors.rows.some((row) => row.reason_code === code && row.p_bps > 0);
}

/** Percentage from integer basis points, for display only. */
export function formatRate(rateBps: number): string {
  return `${(rateBps / 100).toFixed(1)}%`;
}

/**
 * One amount as a percentage of another.
 *
 * Integer arithmetic via basis points rather than `Number(bigint) / Number(bigint)`. This
 * is display-only, so a float would be harmless — but the moment one is acceptable "just
 * for display" is the moment the discipline stops being checkable, and both call sites
 * print a headline figure.
 */
export function percentOfPaise(value: Paise, reference: Paise): string {
  if (reference === ZERO) return '—';
  return `${(Number((value * 10_000n) / reference) / 100).toFixed(1)}%`;
}
