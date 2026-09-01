import { PaiseSchema, ZERO, add, bps, mulBps, sub, type Paise } from '@rc/core';
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
   * Zero for the Recovery Controller by construction — the gate refuses them. For a
   * baseline it is the size of the waste, measured against the policy's own beliefs rather
   * than against hindsight, which is what makes it a fair criticism instead of a gotcha.
   */
  readonly negativeEvAttempts: number;
  readonly negativeEvSpend: Paise;

  readonly refusalsByVerdict: Readonly<Record<string, number>>;
  readonly contactsSent: number;
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
    .select(['txn.id as id', 'txn.margin_bps as margin_bps', 'failure_event.raw as raw'])
    .where('txn.batch_id', '=', batch.id)
    .execute();

  const marginByTxn = new Map<string, number>();
  let recoverable = 0;

  for (const txn of txns) {
    marginByTxn.set(txn.id, txn.margin_bps);
    if (hasNonZeroPrior(args.priors, trueCodeOf(txn.raw))) recoverable += 1;
  }

  // ---- what happened ------------------------------------------------------
  const outcomes = await db
    .selectFrom('outcome')
    .innerJoin('decision', 'decision.id', 'outcome.decision_id')
    .select([
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
  let gatewayFees = ZERO;
  let negativeEvSpend = ZERO;
  let negativeEvAttempts = 0;
  const recoveredTxns = new Set<string>();

  for (const row of outcomes) {
    const fee = PaiseSchema.parse(row.fee_paise);
    gatewayFees = add(gatewayFees, fee);

    if (PaiseSchema.parse(row.ev_net_paise) < ZERO) {
      negativeEvAttempts += 1;
      negativeEvSpend = add(negativeEvSpend, fee);
    }

    if (!row.success) continue;

    const recovered = PaiseSchema.parse(row.recovered_paise);
    const margin = marginByTxn.get(row.txn_id);
    if (margin === undefined) throw new Error(`Outcome for unknown txn ${row.txn_id}`);

    grossRecovered = add(grossRecovered, recovered);
    valueRecovered = add(valueRecovered, mulBps(recovered, bps(margin)));
    recoveredTxns.add(row.txn_id);
  }

  // ---- the other two cost lines -------------------------------------------
  const messages = await db
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .select(['message_send.cost_paise as cost_paise'])
    .where('decision.batch_id', '=', batch.id)
    .execute();

  const messageCosts = messages.reduce(
    (total, row) => add(total, PaiseSchema.parse(row.cost_paise)),
    ZERO,
  );

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
    .select(['verdict'])
    .where('batch_id', '=', batch.id)
    .execute();

  const refusalsByVerdict: Record<string, number> = {};
  let attemptsFired = 0;
  for (const row of decisions) {
    if (row.verdict === 'fire') attemptsFired += 1;
    else refusalsByVerdict[row.verdict] = (refusalsByVerdict[row.verdict] ?? 0) + 1;
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
  };
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
