import {
  REASON_CODES,
  REASON_CODE_META,
  ReasonCodeSchema,
  addHours,
  traceId as brandTraceId,
  txnId as brandTxnId,
  type ReasonCode,
} from '@rc/core';
import type { Arm as ArmId, Db } from '@rc/db';
import {
  executeDecision,
  loadAttemptHistory,
  loadPlanContext,
  type ExecuteDeps,
} from '@rc/engine';
import type { Policy, PriorTable } from '@rc/policy';
import { createSimulatorGateway, loadTruthModel } from '@rc/simulator';
import { ORACLE_CLASSIFIER, type Classification, type ClassificationInput } from '@rc/ai';
import { armById } from './arms.js';
import { attemptLandsAt, gapSinceLastAttempt } from './schedule.js';

/** Perfect classification, from the simulator's seeded record. The measurement ceiling. */
export const ORACLE_CLASSIFY: RunClassifier = (input, trueReasonCode) =>
  ORACLE_CLASSIFIER.classifyWithTruth({ ...input, trueReasonCode });

/**
 * THE BATCH RUNNER
 *
 * Drives one arm over one batch, transaction by transaction, on simulated time.
 *
 * It does NOT go through the queue, and that is a deliberate architectural choice rather
 * than a shortcut. BullMQ would introduce nondeterministic ordering, and "same seed, same
 * numbers" — the reproducibility claim the README makes and a large part of what this
 * submission is offering — would quietly become false. The worker exists for the live
 * streaming demonstration; measurement runs the same engine directly.
 *
 * Simulated time matters for the same reason. Each transaction's clock starts at its own
 * `failed_at` and advances by the nominal duration of whichever timing bucket the arm
 * chose. Nothing reads the wall clock, so the run is reproducible on any machine at any
 * hour — including the quiet-hours behaviour, which would otherwise depend on when the
 * judge happened to run it.
 */

/** Hard stop on the per-transaction loop. Every arm's own rules should bind long before. */
const MAX_STEPS_PER_TXN = 6;

/**
 * How many transactions are classified at once.
 *
 * Classification is network-bound and per-transaction independent, so running it serially
 * made the LLM arm take about fifteen minutes for 360 calls — too slow to demonstrate
 * live, and slow enough that a judge would assume something had hung.
 *
 * Safe for reproducibility, which is the only reason it is allowed: the gateway's outcome
 * draw is keyed on each attempt's own idempotency key rather than on a shared generator, so
 * completion order cannot change any result. The DECISION loop below stays strictly
 * sequential, because attempt ordering and the batch fee budget genuinely do depend on it.
 *
 * Eight rather than higher: the classification phase should not be the thing that trips a
 * rate limit on a shared key.
 */
const CLASSIFY_CONCURRENCY = 8;

/**
 * Map with bounded concurrency, preserving input order.
 *
 * Order preservation matters: the decision phase iterates these results and must do so
 * deterministically, or the reproducibility claim dies for a reason that has nothing to do
 * with the model.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * How a run decides the cause of each failure.
 *
 * Takes the seeded truth as a second argument, which only the oracle arm uses. That is
 * deliberately explicit rather than hidden behind a shared context: an arm that can read
 * the answer should have to declare it in its signature, so a production classifier can
 * never silently acquire access to it.
 */
export type RunClassifier = (
  input: ClassificationInput,
  trueReasonCode: string,
) => Promise<Classification>;

export interface RunOptions {
  readonly db: Db;
  readonly seed: number;
  readonly arm: ArmId;
  readonly world?: string;
  readonly policy: Policy;
  readonly priors: PriorTable;
  /**
   * Defaults to the oracle — perfect classification.
   *
   * That default makes a plain `pnpm eval` a measurement of the POLICY in isolation, with
   * classification error held at zero. The ablation then swaps in real classifiers and the
   * difference is what imperfect classification costs, in rupees.
   */
  readonly classify?: RunClassifier;
}

export interface RunResult {
  readonly arm: ArmId;
  readonly label: string;
  readonly batchId: string;
  readonly transactions: number;
  readonly stepsTaken: number;
  readonly fired: number;
  readonly refused: number;
  readonly downgraded: number;
  readonly succeeded: number;
  /** Transactions the classifier declined to label, and which therefore escalated. */
  readonly quarantined: number;
  /**
   * Transactions labelled with a cause other than the seeded one.
   *
   * Includes quarantines, because a quarantine IS a departure from the true label — it is
   * simply the safe kind. The report separates the two, since one wastes an opportunity
   * and the other wastes a fee.
   */
  readonly misclassified: number;
}

export async function runArm(options: RunOptions): Promise<RunResult> {
  const { db, seed, policy, priors } = options;
  const world = options.world ?? 'base';
  const arm = armById(options.arm);

  const batch = await db
    .selectFrom('batch')
    .select(['id'])
    .where('seed', '=', seed)
    .where('arm', '=', options.arm)
    .where('world', '=', world)
    .executeTakeFirstOrThrow(
      () =>
        new Error(
          `No batch for seed ${seed}, arm ${options.arm}, world "${world}". Run \`pnpm seed\` first.`,
        ),
    );

  // Refuse to evaluate a batch twice.
  //
  // A second run does not repeat the first: it CONTINUES it. Attempt numbers carry on from
  // where the previous run stopped, so the naive arm's "one immediate retry" has already
  // been used and plans nothing, while the controller resumes mid-schedule — and the
  // metrics sum both runs. The output looks plausible and means nothing.
  //
  // `decision` and `audit` are delete-protected by design, so this cannot tidy up after
  // itself. Failing with an actionable message is the only honest option, and it is far
  // better than a judge running `pnpm eval` twice and quietly reading doubled figures.
  const existing = await db
    .selectFrom('decision')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('batch_id', '=', batch.id)
    .executeTakeFirstOrThrow();

  if (Number.parseInt(existing.n, 10) > 0) {
    throw new Error(
      `Batch ${options.arm} (seed ${seed}, world "${world}") has already been evaluated ` +
        `and cannot be re-run: attempt numbering would continue rather than restart.\n` +
        `  Run \`pnpm demo\` for a clean cycle, or \`pnpm db:reset && pnpm seed\` first.`,
    );
  }

  const gateway = await createSimulatorGateway({ db, seed, batchId: batch.id });

  // Loaded ONLY for the oracle arm, and only because it is the ceiling. `external_ref`
  // carries the issuer precisely so that no ordinary query joins a policy to information a
  // real merchant would not have; reading it here is the one sanctioned exception, and it
  // is confined to an arm that cannot ship.
  const truthModel = options.arm === 'b3_oracle' ? loadTruthModel() : null;
  const issuerByCustomer = new Map<string, string>();

  if (truthModel !== null) {
    const rows = await db
      .selectFrom('customer')
      .innerJoin('txn', 'txn.customer_id', 'customer.id')
      .select(['customer.id as id', 'customer.external_ref as external_ref'])
      .where('txn.batch_id', '=', batch.id)
      .distinct()
      .execute();

    for (const row of rows) {
      const issuer = row.external_ref.split(':').at(-1);
      if (issuer === undefined || issuer === '') {
        throw new Error(`Customer ${row.id} has no issuer encoded in external_ref`);
      }
      issuerByCustomer.set(row.id, issuer);
    }
  }
  const deps: ExecuteDeps = { db, gateway, policy };

  // Ordered by `failed_at` then `id`: deterministic, and the tie-break matters because
  // several failures share a minute. Without it Postgres is free to return any order and
  // the run stops being reproducible even though every draw is seeded.
  const txns = await db
    .selectFrom('txn')
    .innerJoin('failure_event', 'failure_event.txn_id', 'txn.id')
    .select([
      'txn.id as id',
      'txn.failed_at as failed_at',
      'failure_event.raw as raw',
      'failure_event.gateway_code as gateway_code',
      'failure_event.gateway_description as gateway_description',
    ])
    .where('txn.batch_id', '=', batch.id)
    .orderBy('txn.failed_at', 'asc')
    .orderBy('txn.id', 'asc')
    .execute();

  await ensureReasonCodesSeeded(db);

  const classify = options.classify ?? ORACLE_CLASSIFY;
  let quarantined = 0;
  let misclassified = 0;

  let stepsTaken = 0;
  let fired = 0;
  let refused = 0;
  let downgraded = 0;
  let succeeded = 0;

  // ---- phase 1: classify, concurrently ------------------------------------
  // Classified ONCE per transaction, not per attempt. A retry does not re-diagnose the
  // original failure, and re-classifying would multiply model cost by attempt count while
  // producing the same answer.
  const classified = await mapBounded(txns, CLASSIFY_CONCURRENCY, async (row) => {
    const trueCode = trueReasonCode(row.raw);
    return {
      row,
      trueCode,
      classification: await classify(
        { description: row.gateway_description, gatewayCode: row.gateway_code },
        trueCode,
      ),
    };
  });

  // Persisted in input order, after the concurrent phase, so the rows land deterministically
  // however the calls happened to complete.
  for (const item of classified) {
    await recordClassification(db, {
      txnId: item.row.id,
      batchId: batch.id,
      classification: item.classification,
      traceId: `${options.arm}:${world}:${item.row.id}:classify`,
      at: item.row.failed_at,
    });

    if (item.classification.quarantined) quarantined += 1;
    if (item.classification.reasonCode !== item.trueCode) misclassified += 1;
  }

  // ---- phase 2: decide, strictly sequentially ------------------------------
  for (const { row, classification } of classified) {
    const txnId = brandTxnId(row.id);

    // The classifier's answer, not the truth. This single substitution is what turns the
    // run from a measurement of the policy into a measurement of the whole loop — and a
    // quarantined transaction arrives here as `unknown`, whose policy entry permits no
    // attempts and escalates. No intervention fires on an unidentified cause.
    const reasonCode = classification.reasonCode;

    let clock = row.failed_at;
    let previousLanding: Date | null = null;
    let recovered = false;

    for (let step = 0; step < MAX_STEPS_PER_TXN && !recovered; step += 1) {
      // The landing time is resolved BEFORE the rest of the context is read, and the order
      // matters. `contactsThisWeek` counts messages in the seven days before `now`, and an
      // attempt scheduled into the salary window lands up to 72 hours after the moment the
      // decision is taken — so reading the contact history at the decision moment evaluates
      // the weekly ceiling against the wrong window.
      //
      // Attempt numbering does not depend on the clock, so it can be read first and used to
      // resolve the landing; everything clock-sensitive is then read at the landing itself.
      const history = await loadAttemptHistory(db, txnId);

      const landsAt = attemptLandsAt({
        policy,
        reasonCode,
        attemptNo: history.firedCount + 1,
        failedAt: row.failed_at,
        previousLanding,
        fallback: clock,
      });
      clock = landsAt;

      const context = await loadPlanContext(db, {
        txnId,
        now: landsAt,
        policy,
        reasonCode,
      });

      const issuerId = issuerByCustomer.get(context.txn.customerId);

      const plan = arm.plan(
        {
          now: clock,
          policy,
          priors,
          reasonCode,
          amount: context.txn.amount,
          marginBps: context.txn.marginBps,
          currentRail: context.txn.rail,
          attemptNo: context.attemptNo,
          hoursSinceLastAttempt: gapSinceLastAttempt(previousLanding, landsAt),
          contactsThisWeek: context.contactsThisWeek,
          consent: context.consent,
          template: context.template,
          batchFeeRemaining: context.batchFeeRemaining,
        },
        {
          priors,
          ...(truthModel !== null && issuerId !== undefined
            ? { truth: { model: truthModel, issuerId } }
            : {}),
        },
      );

      if (plan === null) break;

      stepsTaken += 1;

      const result = await executeDecision(deps, {
        txn: context.txn,
        reasonCode,
        plan,
        // One trace per (transaction, step), so every audit row, decision and gateway call
        // for one action joins on a single key.
        traceId: brandTraceId(`${options.arm}:${txnId}:${step + 1}`),
        attemptNo: context.attemptNo,
        at: clock,
      });

      if (result.kind === 'refused') {
        refused += 1;
        break;
      }

      if (result.kind === 'downgraded') {
        downgraded += 1;
        break;
      }

      fired += 1;
      if (result.outcome.succeeded) {
        succeeded += 1;
        recovered = true;
        break;
      }

      // This attempt landed here. The next one is scheduled from the failure instant, not
      // from this moment, so only the landing is recorded.
      previousLanding = landsAt;
    }
  }

  await db
    .updateTable('batch')
    .set({ finished_at: simulatedBatchEnd(txns), policy_version: policy.version })
    .where('id', '=', batch.id)
    .execute();

  return {
    arm: options.arm,
    label: arm.label,
    batchId: batch.id,
    transactions: txns.length,
    stepsTaken,
    fired,
    refused,
    downgraded,
    succeeded,
    quarantined,
    misclassified,
  };
}

/**
 * Persist one classification, and its model call if there was one.
 *
 * Two tables, because they answer different questions. `classification` records what was
 * decided about this transaction; `llm_call` records what the model cost. Keeping the cost
 * ledger separate is what lets the report state rupees-per-thousand-classifications
 * without joining through the decision path — and it means a classifier that makes no
 * model call simply writes no row there, rather than writing a zero.
 */
async function recordClassification(
  db: Db,
  args: {
    readonly txnId: string;
    readonly batchId: string;
    readonly classification: Classification;
    readonly traceId: string;
    readonly at: Date;
  },
): Promise<void> {
  const c = args.classification;

  await db
    .insertInto('classification')
    .values({
      txn_id: args.txnId,
      reason_code: c.reasonCode,
      confidence_bps: c.confidenceBps,
      method: c.method,
      model: c.model,
      prompt_hash: c.promptHash,
      quarantined: c.quarantined,
      input_tokens: c.inputTokens,
      output_tokens: c.outputTokens,
      cost_paise: c.costPaise.toString(),
      latency_ms: c.latencyMs,
      created_at: args.at,
    })
    .execute();

  // Only a real model call gets a cost-ledger row. The keyword and oracle arms are free
  // and instant; recording zero-cost rows for them would dilute every per-call average.
  if (c.model === null || c.model === 'oracle') return;

  await db
    .insertInto('llm_call')
    .values({
      trace_id: args.traceId,
      batch_id: args.batchId,
      purpose: 'classify',
      model: c.model,
      input_tokens: c.inputTokens,
      output_tokens: c.outputTokens,
      cached_tokens: c.cachedTokens,
      cost_paise: c.costPaise.toString(),
      latency_ms: c.latencyMs,
      ok: c.error === null,
      error: c.error,
      created_at: args.at,
    })
    .execute();
}

/**
 * The batch's simulated end, not the wall clock.
 *
 * `finished_at` is metadata about the simulation, so stamping it with `now()` would make
 * two runs of the same seed differ in the database even though every decision matched.
 */
function simulatedBatchEnd(txns: readonly { readonly failed_at: Date }[]): Date {
  const last = txns.at(-1);
  // Two weeks past the last failure: long enough to cover every schedule in the policy.
  return last === undefined ? SIM_FALLBACK_END : addHours(last.failed_at, 24 * 14);
}

const SIM_FALLBACK_END = new Date('2026-06-01T00:00:00.000Z');

/**
 * The true cause, read from the simulator's record.
 *
 * A deliberate, temporary shortcut: it makes this run a PERFECT-CLASSIFICATION arm, which
 * is a meaningful upper bound in its own right. Milestone 5 introduces the keyword and LLM
 * classifiers, and the ablation then measures what imperfect classification costs against
 * this ceiling.
 *
 * The eval harness is the one package permitted to read simulator truth. Nothing in
 * `@rc/policy` or `@rc/engine` can reach this value.
 */
function trueReasonCode(raw: unknown): ReasonCode {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('failure_event.raw is not an object; cannot read the seeded cause');
  }

  const simulator = (parsed as Record<string, unknown>)['simulator'];
  if (typeof simulator !== 'object' || simulator === null) {
    throw new Error('failure_event.raw has no `simulator` block');
  }

  return ReasonCodeSchema.parse(
    (simulator as Record<string, unknown>)['true_reason_code'],
  );
}

/**
 * Ensure the taxonomy rows exist.
 *
 * The taxonomy is a table rather than an enum so the open-world path can propose new codes
 * at runtime, which means something has to seed the known ones. Idempotent, so it is safe
 * to call before every arm.
 */
async function ensureReasonCodesSeeded(db: Db): Promise<void> {
  await db
    .insertInto('reason_code')
    .values(
      REASON_CODES.map((code) => ({
        code,
        terminal: REASON_CODE_META[code].terminal,
        notifiable: REASON_CODE_META[code].notifiable,
        never_contact: REASON_CODE_META[code].neverContact,
        note: REASON_CODE_META[code].note,
      })),
    )
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();
}
