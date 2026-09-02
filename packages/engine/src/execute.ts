import {
  PaiseSchema,
  ZERO,
  add,
  bps,
  customerId as brandCustomerId,
  idempotencyKey as brandKey,
  txnId as brandTxnId,
  formatINR,
  incursGatewayFee,
  toRupeeString,
  type Channel,
  type Gateway,
  type GatewayOutcome,
  type IdempotencyKey,
  type Paise,
  type TraceId,
  type TxnId,
} from '@rc/core';
import {
  lockBatchBudget,
  withTx,
  type Db,
  type DbOrTx,
  type PlannedAction,
  type Verdict,
} from '@rc/db';
import type { Policy } from '@rc/policy';
import { deriveIdempotencyKey } from './idempotency.js';
import type { Plan } from './plan.js';
import type { TxnContext } from './repository.js';

/**
 * EXECUTION, AND THE DUAL-WRITE PROBLEM
 *
 * A fired attempt spans three steps that cannot be one atomic operation, because the
 * middle one leaves the database:
 *
 *   1. Record the decision as `pending`, reserve the fee, write the audit row.  [TX]
 *   2. Call the gateway.                                                    [side effect]
 *   3. Record the outcome, settle the decision, write the audit row.            [TX]
 *
 * A crash between 1 and 3 is the interesting case, and it is the first thing anyone will
 * probe about a live crash-resume demo. The process comes back not knowing whether the
 * dispatch reached the gateway. Guessing either way is wrong: assume it did and a
 * recoverable payment is abandoned; assume it did not and the customer may be charged
 * twice.
 *
 * So it does not guess. `reconcileStranded` asks the gateway what happened to that
 * idempotency key. Found — settle from the gateway's record. Not found — the dispatch
 * never landed, so re-send it under the same key. Either way exactly one charge exists,
 * and the key is a pure function of (transaction, attempt number, policy version) so the
 * restarted process derives the identical one.
 *
 * On the fee reservation: step 1 debits the budget before the gateway is called, which is
 * an authorisation hold rather than a ledger entry. It can over-reserve when an attempt is
 * abandoned. That is deliberate — a reservation that errs toward over-counting can never
 * overspend the ceiling, whereas one that errs the other way can. Reported cost comes from
 * `outcome.fee_paise`, which is what was actually charged; `batch_budget.fee_spent_paise`
 * is the conservative hold that keeps concurrent workers honest.
 */

export interface ExecuteDeps {
  readonly db: Db;
  readonly gateway: Gateway;
  readonly policy: Policy;
}

export interface ExecuteArgs {
  readonly txn: TxnContext;
  readonly reasonCode: string;
  readonly plan: Plan;
  readonly traceId: TraceId;
  readonly attemptNo: number;
  /**
   * The decision's timestamp.
   *
   * Passed in rather than taken from the clock, because the eval harness runs on simulated
   * time and `now()` would make the same seed produce different rows on every run.
   */
  readonly at: Date;
}

export type ExecuteResult =
  | { readonly kind: 'fired'; readonly decisionId: string; readonly outcome: GatewayOutcome }
  | { readonly kind: 'refused'; readonly decisionId: string; readonly verdict: string }
  | {
      /** Planned as a fire, downgraded after the budget lock showed it could not be paid for. */
      readonly kind: 'downgraded';
      readonly decisionId: string;
      readonly detail: string;
    };

/**
 * Record and carry out one planned decision.
 *
 * The plan is already made; nothing here decides anything except whether the fee is still
 * affordable, which cannot be known until the budget row is locked.
 */
export async function executeDecision(
  deps: ExecuteDeps,
  args: ExecuteArgs,
): Promise<ExecuteResult> {
  const { db, gateway, policy } = deps;
  const { plan, txn, traceId, at } = args;

  if (plan.kind === 'refuse') {
    const decisionId = await recordRefusal(db, args, policy);
    return { kind: 'refused', decisionId, verdict: plan.verdict };
  }

  const fee = policy.gatewayFee(plan.rail);
  const key = deriveIdempotencyKey(txn.txnId, args.attemptNo, policy.version);

  // ---- step 1: reserve and record, atomically ------------------------------
  const reserved = await withTx(db, async (tx) => {
    // The lock is the single point of serialisation in the system. Two workers planning
    // against the same batch both read a remaining balance before either spends; without
    // this, both would believe they could afford the last attempt.
    const budget = await lockBatchBudget(tx, txn.batchId);

    if (fee > budget.remaining) {
      // The plan was computed on a read taken before the lock, and another worker got
      // there first. Downgrading here rather than throwing keeps the transaction in the
      // audit trail with an honest reason, instead of vanishing from the batch.
      const detail =
        `Batch fee budget exhausted between planning and execution: ` +
        `${formatINR(budget.remaining)} remaining, ${formatINR(fee)} required.`;

      const id = await insertDecision(tx, {
        args,
        policyVersion: policy.version,
        verdict: 'refuse_bounds',
        action: 'none',
        refuseDetail: detail,
        // The downgrade path: the plan passed the gate and lost a race for the budget between
        // planning and execution. Named as the budget bound, because that is what stopped it.
        refuseRule: 'batch_fee_budget',
        attemptNo: null,
        key: null,
        state: 'planned',
      });

      await insertAudit(tx, {
        traceId,
        txnId: txn.txnId,
        batchId: txn.batchId,
        decisionId: id,
        eventType: 'decision.downgraded',
        actor: 'policy_engine',
        policyVersion: policy.version,
        at,
        rationale: detail,
        payload: { remaining: toRupeeString(budget.remaining), fee: toRupeeString(fee) },
      });

      return { downgraded: true as const, decisionId: id, detail };
    }

    const decisionId = await insertDecision(tx, {
      args,
      policyVersion: policy.version,
      verdict: 'fire',
      action: plan.action,
      refuseDetail: null,
      refuseRule: null,
      attemptNo: args.attemptNo,
      key,
      state: 'pending',
    });

    await tx
      .updateTable('batch_budget')
      .set({ fee_spent_paise: add(budget.spent, fee).toString() })
      .where('batch_id', '=', txn.batchId)
      .execute();

    await insertAudit(tx, {
      traceId,
      txnId: txn.txnId,
      batchId: txn.batchId,
      decisionId,
      eventType: 'attempt.dispatched',
      actor: 'policy_engine',
      policyVersion: policy.version,
      at,
      rationale:
        `Attempt ${args.attemptNo} on ${plan.rail} at ${plan.timing}. ` +
        `Expected net ${formatINR(plan.ev.net)} against a ${formatINR(fee)} fee.`,
      payload: {
        idempotency_key: key,
        rail: plan.rail,
        timing: plan.timing,
        p_bps: plan.ev.pBps,
      },
    });

    return { downgraded: false as const, decisionId, detail: '' };
  });

  if (reserved.downgraded) {
    return { kind: 'downgraded', decisionId: reserved.decisionId, detail: reserved.detail };
  }

  // ---- step 2: the side effect, outside any transaction --------------------
  // A crash from here until step 3 commits leaves the decision `pending`, which is what
  // `reconcileStranded` exists to resolve.
  const outcome = await gateway.attempt({
    idempotencyKey: key,
    amount: txn.amount,
    rail: plan.rail,
    // Assembled, not interpreted. The engine does not know or care what the gateway does
    // with these; a live processor would use them for routing hints, and the simulator
    // conditions its ground truth on them.
    context: {
      txn_id: txn.txnId,
      logical_ref: txn.logicalRef,
      customer_id: txn.customerId,
      reason_code: args.reasonCode,
      attempt_no: String(args.attemptNo),
      timing: plan.timing,
      // What the action IS, not just when it lands. The simulator needs it for two
      // independent reasons: only a charging action incurs a fee, and "will a retry
      // authorise" and "will this customer tap a link" are different questions with
      // different answers at the same timing.
      action: plan.action,
    },
  });

  // ---- step 3: settle ------------------------------------------------------
  await settle(db, {
    decisionId: reserved.decisionId,
    txn,
    traceId,
    at,
    outcome,
    policyVersion: policy.version,
    contact: plan.contact.send ? plan.contact : null,
    messageCost: plan.contact.send ? policy.messageCost(plan.contact.channel) : ZERO,
  });

  return { kind: 'fired', decisionId: reserved.decisionId, outcome };
}

/**
 * Resolve decisions left `pending` by a crash.
 *
 * `FOR UPDATE SKIP LOCKED` lets several workers run this concurrently without two of them
 * reconciling the same row — the second simply skips it and moves on rather than blocking.
 *
 * `olderThanMs` is a lease: a decision dispatched two seconds ago is probably still in
 * flight in a healthy process, and reconciling it would race the worker that owns it.
 */
export async function reconcileStranded(
  deps: ExecuteDeps,
  args: {
    readonly batchId: string;
    readonly now: Date;
    readonly olderThanMs?: number;
    readonly limit?: number;
  },
): Promise<{ readonly settled: number; readonly redispatched: number }> {
  const cutoff = new Date(args.now.getTime() - (args.olderThanMs ?? 30_000));
  let settled = 0;
  let redispatched = 0;

  const stranded = await deps.db
    .selectFrom('decision')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .select([
      'decision.id as decision_id',
      'decision.txn_id',
      'decision.trace_id',
      'decision.idempotency_key',
      'decision.planned_rail',
      'decision.planned_action',
      'decision.reason_code',
      'decision.attempt_no',
      'decision.planned_timing',
      'txn.amount_paise',
      'txn.margin_bps',
      'txn.customer_id',
      'txn.batch_id',
      'txn.logical_ref',
      // The rail the original payment used. Needed because `planned_rail` is deliberately
      // null for an action that presents no charge, and the gateway request still needs a
      // rail field — one whose fee it will not charge.
      'txn.rail as txn_rail',
      'txn.risk_class',
      'txn.lifetime_cycles',
      'txn.days_overdue',
      'txn.mandate_ref',
    ])
    .where('decision.batch_id', '=', args.batchId)
    .where('decision.state', '=', 'pending')
    .where('decision.updated_at', '<', cutoff)
    .orderBy('decision.updated_at', 'asc')
    .limit(args.limit ?? 100)
    .forUpdate()
    .skipLocked()
    .execute();

  for (const row of stranded) {
    if (row.idempotency_key === null || row.planned_timing === null) {
      // The `decision_fire_is_identified` and `decision_fire_has_timing` constraints make
      // this unreachable. Asserting it anyway means a future migration that relaxed either
      // constraint would surface here rather than as a silently mispriced reconciliation.
      throw new Error(
        `decision ${row.decision_id} is pending but incompletely identified ` +
          `(key/timing); a CHECK constraint should have made this impossible`,
      );
    }

    // `planned_rail` is null exactly when the action presents no charge, which the
    // `decision_rail_only_when_charging` constraint guarantees. Both halves are asserted so
    // a relaxed constraint surfaces here rather than as a reconciliation that re-dispatches
    // a payment link as a card charge.
    const charging = incursGatewayFee(row.planned_action);
    if (charging !== (row.planned_rail !== null)) {
      throw new Error(
        `decision ${row.decision_id} records action ${row.planned_action} with ` +
          `planned_rail ${String(row.planned_rail)}; a charge must name a rail and a ` +
          'non-charging action must not.',
      );
    }
    const rail = row.planned_rail ?? row.txn_rail;

    const key = brandKey(row.idempotency_key);

    // Reconstructed from the row rather than partially faked. An earlier version filled
    // `marginBps` with a cast zero because the settle path does not read it — a lie inside
    // a typed structure, and the kind that stays harmless right up until someone adds a
    // line that does read it and gets a silent zero instead of a margin.
    const txn: TxnContext = {
      txnId: brandTxnId(row.txn_id),
      batchId: row.batch_id,
      customerId: brandCustomerId(row.customer_id),
      amount: PaiseSchema.parse(row.amount_paise),
      marginBps: bps(row.margin_bps),
      rail,
      logicalRef: row.logical_ref,
      riskClass: row.risk_class,
      lifetimeCycles: row.lifetime_cycles,
      daysOverdue: row.days_overdue,
      mandateBacked: row.mandate_ref !== null && row.risk_class !== 'mandate_lapsed',
    };

    // The question the whole design turns on: did the previous dispatch reach the gateway?
    let outcome = await gatewayLookup(deps.gateway, key);

    if (outcome === null) {
      // It did not. Re-sending under the same key is safe precisely because the key is
      // derived rather than random — the gateway will deduplicate if this is wrong.
      outcome = await deps.gateway.attempt({
        idempotencyKey: key,
        amount: txn.amount,
        rail,
        context: {
          txn_id: row.txn_id,
          logical_ref: row.logical_ref,
          customer_id: row.customer_id,
          reason_code: row.reason_code,
          attempt_no: String(row.attempt_no ?? 1),
          timing: row.planned_timing,
          action: row.planned_action,
        },
      });
      redispatched += 1;
    }

    await settle(deps.db, {
      decisionId: row.decision_id,
      txn,
      traceId: row.trace_id as TraceId,
      at: args.now,
      outcome,
      policyVersion: deps.policy.version,
      contact: null,
      messageCost: ZERO,
      reconciled: true,
    });

    settled += 1;
  }

  return { settled, redispatched };
}

async function gatewayLookup(
  gateway: Gateway,
  key: IdempotencyKey,
): Promise<GatewayOutcome | null> {
  return gateway.lookup(key);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function settle(
  db: Db,
  args: {
    readonly decisionId: string;
    readonly txn: TxnContext;
    readonly traceId: TraceId;
    readonly at: Date;
    readonly outcome: GatewayOutcome;
    readonly policyVersion: number;
    readonly contact: { readonly channel: Channel; readonly templateId: string } | null;
    readonly messageCost: Paise;
    readonly reconciled?: boolean;
  },
): Promise<void> {
  await withTx(db, async (tx) => {
    await tx
      .insertInto('outcome')
      .values({
        decision_id: args.decisionId,
        success: args.outcome.succeeded,
        gateway_code: args.outcome.code,
        fee_paise: args.outcome.fee.toString(),
        recovered_paise: args.outcome.recovered.toString(),
        settled_at: args.at,
      })
      .execute();

    await tx
      .updateTable('decision')
      .set({ state: 'settled', updated_at: args.at })
      .where('id', '=', args.decisionId)
      .execute();

    if (args.contact !== null) {
      await sendMessage(tx, {
        decisionId: args.decisionId,
        customerId: args.txn.customerId,
        contact: args.contact,
        cost: args.messageCost,
        at: args.at,
      });
    }

    await insertAudit(tx, {
      traceId: args.traceId,
      txnId: args.txn.txnId,
      batchId: args.txn.batchId,
      decisionId: args.decisionId,
      eventType: args.reconciled === true ? 'attempt.reconciled' : 'attempt.settled',
      actor: args.reconciled === true ? 'worker' : 'policy_engine',
      policyVersion: args.policyVersion,
      at: args.at,
      rationale: args.outcome.succeeded
        ? `Recovered ${formatINR(args.outcome.recovered)} for a ${formatINR(args.outcome.fee)} fee.`
        : `Attempt failed (${args.outcome.code ?? 'no code'}); ${formatINR(args.outcome.fee)} spent.`,
      payload: {
        succeeded: args.outcome.succeeded,
        fee: toRupeeString(args.outcome.fee),
        recovered: toRupeeString(args.outcome.recovered),
        reconciled: args.reconciled ?? false,
      },
    });
  });
}

/**
 * Send one message through a registered template.
 *
 * Shared by the settle path and the refusal path, and it exists BECAUSE it was not shared.
 * `recordRefusal` used to write the decision and the audit row and silently drop
 * `plan.contact` — so every escalation was inert. That is not a small omission: for
 * `card_expired` and `mandate_expired` the nudge is the ONLY intervention with non-zero
 * value, since retrying an expired card or a revoked mandate cannot succeed. Fifty-one
 * transactions per batch were being escalated to nobody.
 *
 * The failure was invisible from the outside: the plan said notify, the audit row said
 * escalated, and no message existed. One function used by both paths is the fix.
 */
async function sendMessage(
  tx: DbOrTx,
  args: {
    readonly decisionId: string;
    readonly customerId: string;
    readonly contact: { readonly channel: Channel; readonly templateId: string };
    readonly cost: Paise;
    readonly at: Date;
  },
): Promise<void> {
  await tx
    .insertInto('message_send')
    .values({
      decision_id: args.decisionId,
      customer_id: args.customerId,
      template_id: args.contact.templateId,
      channel: args.contact.channel,
      // Variable filling lands with the renderer. The template id is the record of what was
      // sent, and because `template_id` is NOT NULL against a registered row, there is no
      // path by which free-form text could be sent in its place.
      rendered_body: `[template ${args.contact.templateId}]`,
      variables: JSON.stringify({}),
      cost_paise: args.cost.toString(),
      sent_at: args.at,
    })
    .execute();
}

async function recordRefusal(
  db: Db,
  args: ExecuteArgs,
  policy: Policy,
): Promise<string> {
  if (args.plan.kind !== 'refuse') throw new Error('unreachable: recordRefusal on a fire');
  const plan = args.plan;

  return withTx(db, async (tx) => {
    const decisionId = await insertDecision(tx, {
      args,
      policyVersion: policy.version,
      verdict: plan.verdict,
      action: plan.action,
      refuseDetail: plan.detail,
      refuseRule: plan.rule,
      attemptNo: null,
      key: null,
      state: 'planned',
    });

    // An escalation still contacts the customer when the policy says so and the bounds
    // permit it. This is the whole intervention for a terminal cause.
    if (plan.contact.send) {
      await sendMessage(tx, {
        decisionId,
        customerId: args.txn.customerId,
        contact: plan.contact,
        cost: policy.messageCost(plan.contact.channel),
        at: args.at,
      });
    }

    await insertAudit(tx, {
      traceId: args.traceId,
      txnId: args.txn.txnId,
      batchId: args.txn.batchId,
      decisionId,
      eventType: plan.action === 'escalate' ? 'decision.escalated' : 'decision.refused',
      actor: 'policy_engine',
      policyVersion: policy.version,
      at: args.at,
      // The refusal explains itself in rupees. This is the string an operator reads in the
      // exception queue, and the reason the arithmetic is on the row beside it.
      rationale: `${plan.detail} Would have been worth ${formatINR(plan.ev.net)} net.`,
      payload: {
        verdict: plan.verdict,
        p_bps: plan.ev.pBps,
        value: toRupeeString(plan.ev.value),
        cost: toRupeeString(plan.ev.cost),
        net: toRupeeString(plan.ev.net),
        contact_blocked: plan.contact.send ? null : plan.contact.blockedBy,
      },
    });

    return decisionId;
  });
}

async function insertDecision(
  tx: DbOrTx,
  spec: {
    readonly args: ExecuteArgs;
    /**
     * Stamped onto the row, and part of the idempotency key.
     *
     * An attempt authorised under policy v3 is not the same authorisation as one under
     * v4 — the bounds, timings and floor may all differ — so the row records which set of
     * rules permitted it. This is what makes a decision from nine versions ago
     * reconstructable rather than merely logged.
     */
    readonly policyVersion: number;
    readonly verdict: Verdict;
    readonly action: PlannedAction;
    readonly refuseDetail: string | null;
    /** Null exactly when the verdict is `fire`, enforced by a CHECK constraint. */
    readonly refuseRule: string | null;
    readonly attemptNo: number | null;
    readonly key: IdempotencyKey | null;
    readonly state: 'planned' | 'pending';
  },
): Promise<string> {
  const { args } = spec;
  const ev = args.plan.ev;

  const row = await tx
    .insertInto('decision')
    .values({
      txn_id: args.txn.txnId,
      batch_id: args.txn.batchId,
      trace_id: args.traceId,
      policy_version: spec.policyVersion,
      reason_code: args.reasonCode,
      evaluated_at: args.at,
      verdict: spec.verdict,
      refuse_detail: spec.refuseDetail,
      refuse_rule: spec.refuseRule,
      planned_action: spec.action,
      // Derived from the VERDICT being recorded, not from the plan that was proposed.
      //
      // Those differ on the downgrade path: a `fire` plan whose fee no longer fits the
      // batch budget is recorded as `refuse_bounds`, and taking the rail and timing from
      // the plan meant writing a refusal that claimed to have chosen when to act. The
      // `decision_fire_has_timing` constraint rejected it — correctly, and only once an arm
      // aggressive enough to exhaust the budget existed to trigger it.
      //
      // Also gated on the action PRESENTING A CHARGE. A payment link has no rail until the
      // customer picks one, and a pre-debit notice never has one at all — recording the rail
      // the original payment failed on would assert a fact about an action that never
      // touched a rail. The `decision_rail_only_when_charging` constraint enforces it.
      planned_rail:
        spec.verdict === 'fire' && args.plan.kind === 'fire' && incursGatewayFee(args.plan.action)
          ? args.plan.rail
          : null,
      planned_timing:
        spec.verdict === 'fire' && args.plan.kind === 'fire' ? args.plan.timing : null,
      ev_p_bps: ev.pBps,
      ev_value_paise: ev.value.toString(),
      ev_cost_paise: ev.cost.toString(),
      ev_net_paise: ev.net.toString(),
      attempt_no: spec.attemptNo,
      idempotency_key: spec.key,
      state: spec.state,
      // On the caller's clock, not the database's. The reconciliation lease compares
      // against this column, and a wall-clock default would put it on a different clock
      // from every other timestamp in a simulated run — which is exactly the bug that made
      // reconciliation silently match nothing. See migration 008.
      updated_at: args.at,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return row.id;
}

async function insertAudit(
  tx: DbOrTx,
  spec: {
    readonly traceId: TraceId;
    readonly txnId: TxnId;
    readonly batchId: string;
    readonly decisionId: string | null;
    readonly eventType: string;
    readonly actor: string;
    readonly policyVersion: number;
    readonly at: Date;
    readonly rationale: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await tx
    .insertInto('audit')
    .values({
      trace_id: spec.traceId,
      txn_id: spec.txnId,
      batch_id: spec.batchId,
      decision_id: spec.decisionId,
      event_type: spec.eventType,
      actor: spec.actor,
      policy_version: spec.policyVersion,
      payload: JSON.stringify(spec.payload),
      rationale: spec.rationale,
      occurred_at: spec.at,
    })
    .execute();
}
