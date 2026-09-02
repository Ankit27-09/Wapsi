import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ZERO,
  deterministicId,
  paise,
  paiseFromRupeeString,
  traceId as brandTraceId,
  txnId as brandTxnId,
  customerId as brandCustomerId,
  bps,
  type Gateway,
  type GatewayOutcome,
  type GatewayRequest,
  type IdempotencyKey,
} from '@rc/core';
import { createDb, isDatabaseReachable, type Db } from '@rc/db';
import { loadPolicy, loadPriorTable } from '@rc/policy';
import { deriveIdempotencyKey } from './idempotency.js';
import { executeDecision, reconcileStranded } from './execute.js';
import { planNext } from './plan.js';
import { loadPlanContext, type TxnContext } from './repository.js';

/**
 * Skip rather than fail when Postgres is not running.
 *
 * These tests exist to check things only a real database can check — triggers, CHECK
 * constraints, FOR UPDATE SKIP LOCKED. Somebody who has not started Docker yet should be
 * told that, not handed a wall of connection errors that looks like broken code.
 */
const DATABASE_UP = await isDatabaseReachable();
if (!DATABASE_UP) {
  console.warn(
    `
  SKIPPED: Postgres unreachable. Run \`docker compose up -d\` to run these tests.
`,
  );
}

/**
 * CRASH RESUME, TESTED.
 *
 * This is the question a technical panel asks about a live crash-resume demonstration:
 * *what happens if you die between the gateway call and the database write?* The answer
 * has to be a mechanism, not a hope, and until this file existed it was untested — the
 * single largest gap in the project's coverage.
 *
 * The crash is simulated by driving `executeDecision` with a gateway that charges and then
 * throws before the outcome can be recorded, leaving the decision `pending` exactly as a
 * killed process would. Reconciliation then has to reach the correct conclusion from the
 * gateway's own records.
 *
 * Two cases, and they need opposite handling:
 *
 *   CHARGED, NOT RECORDED — the gateway has a record. Re-dispatching would charge twice,
 *     so reconciliation must settle from the existing record.
 *
 *   NEVER REACHED THE GATEWAY — no record. Settling from nothing would abandon a
 *     recoverable payment, so reconciliation must re-dispatch under the same key.
 */

let db: Db;
let close: () => Promise<void>;

const RUN = Math.floor(Math.random() * 1_000_000_000);
const policy = loadPolicy();
const priors = loadPriorTable();

/** 14:30 IST, outside quiet hours, so contact rules do not interfere. */
const AT = new Date('2026-06-03T09:00:00.000Z');

/**
 * A gateway whose behaviour each test controls.
 *
 * `charged` is the gateway's own memory, deliberately kept OUTSIDE the harness's control
 * flow: that is the property being tested. A gateway whose records vanished when the
 * worker died would make every reconciliation find nothing, and the demonstration would
 * appear to pass while proving the opposite of its claim.
 */
function scriptedGateway(options: {
  readonly succeed: boolean;
  /** Throw after charging, simulating a crash between the call and the DB write. */
  readonly crashAfterCharge: boolean;
  /** Drop the request entirely, simulating a crash before it left the process. */
  readonly dropRequest?: boolean;
}): Gateway & { readonly calls: () => number } {
  const charged = new Map<string, GatewayOutcome>();
  let calls = 0;

  return {
    calls: () => calls,

    async attempt(request: GatewayRequest): Promise<GatewayOutcome> {
      calls += 1;

      const existing = charged.get(request.idempotencyKey);
      if (existing !== undefined) return existing;

      if (options.dropRequest === true) {
        throw new Error('simulated: process died before the request left');
      }

      const outcome: GatewayOutcome = {
        succeeded: options.succeed,
        code: options.succeed ? 'CAPTURED' : 'DECLINED_TEST',
        fee: paiseFromRupeeString('3.50'),
        recovered: options.succeed ? paiseFromRupeeString('4872.13') : ZERO,
      };

      charged.set(request.idempotencyKey, outcome);

      if (options.crashAfterCharge) {
        throw new Error('simulated: process died after the charge, before recording it');
      }
      return outcome;
    },

    async lookup(key: IdempotencyKey): Promise<GatewayOutcome | null> {
      return charged.get(key) ?? null;
    },
  };
}

/** One batch with one transaction, isolated from every other test run. */
async function seedOne(label: string): Promise<TxnContext> {
  const batchId = deterministicId('itest-batch', RUN, label);
  const customerId = deterministicId('itest-customer', RUN, label);
  const txnId = deterministicId('itest-txn', RUN, label);

  await db
    .insertInto('reason_code')
    .values({
      code: 'insufficient_funds',
      terminal: false,
      notifiable: true,
      note: 'Issuer declined for want of balance.',
    })
    .onConflict((oc) => oc.column('code').doNothing())
    .execute();

  await db
    .insertInto('batch')
    .values({ id: batchId, seed: RUN, arm: 'rc', world: `itest-${label}` })
    .execute();

  await db
    .insertInto('batch_budget')
    .values({ batch_id: batchId, fee_budget_paise: '500000' })
    .execute();

  await db
    .insertInto('customer')
    .values({
      id: customerId,
      external_ref: `itest:${RUN}:${label}:ISS_NORTH`,
      display_name: 'Crash Resume Fixture',
    })
    .execute();

  await db
    .insertInto('txn')
    .values({
      id: txnId,
      logical_ref: `0:${label}`,
      batch_id: batchId,
      customer_id: customerId,
      amount_paise: '487213',
      margin_bps: 1900,
      rail: 'card',
      failed_at: AT,
    })
    .execute();

  await db
    .insertInto('failure_event')
    .values({
      txn_id: txnId,
      gateway_code: '51',
      gateway_description: '51 - INSUFFICIENT FUNDS',
      raw: JSON.stringify({
        simulator: { true_reason_code: 'insufficient_funds', rendering: 'labelled' },
      }),
    })
    .execute();

  return {
    txnId: brandTxnId(txnId),
    batchId,
    customerId: brandCustomerId(customerId),
    amount: paise(487213n),
    marginBps: bps(1900),
    rail: 'card',
    logicalRef: `0:${label}`,
    // A one-off card payment: the class with no extra mechanics, so this test stays about
    // crash recovery rather than about e-mandate notice periods.
    riskClass: 'payment_failure',
    lifetimeCycles: null,
    daysOverdue: null,
    mandateBacked: false,
  };
}

/** Drive one attempt with the given gateway, tolerating a simulated crash. */
async function attemptOnce(
  txn: TxnContext,
  gateway: Gateway,
  label: string,
): Promise<{ readonly crashed: boolean }> {
  const context = await loadPlanContext(db, {
    txnId: txn.txnId,
    now: AT,
    policy,
    reasonCode: 'insufficient_funds',
  });

  // Everything the planner needs comes from the loaded context rather than being restated
  // here. That matters for a crash-resume test specifically: a hand-written fixture that
  // drifts from what the repository actually reads would make the reconciliation path
  // resume against a transaction the database does not contain.
  const plan = planNext({
    now: AT,
    policy,
    priors,
    reasonCode: 'insufficient_funds',
    riskClass: context.txn.riskClass,
    amount: txn.amount,
    marginBps: txn.marginBps,
    lifetimeCycles: context.txn.lifetimeCycles,
    currentRail: txn.rail,
    attemptNo: context.attemptNo,
    hoursSinceLastAttempt: context.hoursSinceLastAttempt,
    contactsThisWeek: context.contactsThisWeek,
    callsThisWeek: context.callsThisWeek,
    consent: context.consent,
    template: context.template,
    onNcprRegistry: context.onNcprRegistry,
    mandateBacked: context.txn.mandateBacked,
    hoursSincePreDebitNotice: context.hoursSincePreDebitNotice,
    openPromiseDueAt: context.openPromiseDueAt,
    batchFeeRemaining: context.batchFeeRemaining,
  });

  expect(plan.kind).toBe('fire');

  try {
    await executeDecision(
      { db, gateway, policy },
      {
        txn,
        reasonCode: 'insufficient_funds',
        plan,
        traceId: brandTraceId(`itest:${label}`),
        attemptNo: context.attemptNo,
        at: AT,
      },
    );
    return { crashed: false };
  } catch {
    // The crash. `executeDecision` has committed the pending decision and reserved the
    // fee; the outcome was never written.
    return { crashed: true };
  }
}

beforeAll(async () => {
  ({ db, close } = createDb());
});

afterAll(async () => {
  await close();
});

describe.skipIf(!DATABASE_UP)('reconciliation after a crash between the gateway call and the write', () => {
  it('settles from the gateway record rather than charging twice', async () => {
    const txn = await seedOne('charged');
    const gateway = scriptedGateway({ succeed: true, crashAfterCharge: true });

    const { crashed } = await attemptOnce(txn, gateway, 'charged');
    expect(crashed).toBe(true);
    expect(gateway.calls()).toBe(1);

    // The decision is stranded exactly as a killed worker would leave it.
    const stranded = await db
      .selectFrom('decision')
      .select(['state', 'idempotency_key'])
      .where('txn_id', '=', txn.txnId)
      .executeTakeFirstOrThrow();
    expect(stranded.state).toBe('pending');

    // The key is derived, so the restarted process recomputes the identical one — which is
    // the entire mechanism. A random key would look like a fresh attempt.
    expect(stranded.idempotency_key).toBe(
      deriveIdempotencyKey(txn.txnId, 1, policy.version),
    );

    const report = await reconcileStranded(
      { db, gateway, policy },
      { batchId: txn.batchId, now: new Date(AT.getTime() + 60_000), olderThanMs: 0 },
    );

    expect(report.settled).toBe(1);
    // The critical assertion: NOT re-dispatched. The gateway had a record, so a second
    // dispatch would have charged the customer twice.
    expect(report.redispatched).toBe(0);
    expect(gateway.calls()).toBe(1);

    const outcome = await db
      .selectFrom('outcome')
      .innerJoin('decision', 'decision.id', 'outcome.decision_id')
      .select(['outcome.success', 'outcome.recovered_paise', 'decision.state'])
      .where('decision.txn_id', '=', txn.txnId)
      .executeTakeFirstOrThrow();

    expect(outcome.success).toBe(true);
    expect(outcome.recovered_paise).toBe('487213');
    expect(outcome.state).toBe('settled');
  });

  it('re-dispatches under the same key when the gateway never saw the request', async () => {
    const txn = await seedOne('dropped');
    const dropping = scriptedGateway({
      succeed: true,
      crashAfterCharge: false,
      dropRequest: true,
    });

    const { crashed } = await attemptOnce(txn, dropping, 'dropped');
    expect(crashed).toBe(true);

    const stranded = await db
      .selectFrom('decision')
      .select(['state'])
      .where('txn_id', '=', txn.txnId)
      .executeTakeFirstOrThrow();
    expect(stranded.state).toBe('pending');

    // A fresh gateway with no memory of the key, standing in for the real one having never
    // received the request. Settling from nothing here would abandon a recoverable payment.
    const healthy = scriptedGateway({ succeed: true, crashAfterCharge: false });

    const report = await reconcileStranded(
      { db, gateway: healthy, policy },
      { batchId: txn.batchId, now: new Date(AT.getTime() + 60_000), olderThanMs: 0 },
    );

    expect(report.settled).toBe(1);
    expect(report.redispatched).toBe(1);
    expect(healthy.calls()).toBe(1);

    const outcome = await db
      .selectFrom('outcome')
      .innerJoin('decision', 'decision.id', 'outcome.decision_id')
      .select(['outcome.success', 'decision.state'])
      .where('decision.txn_id', '=', txn.txnId)
      .executeTakeFirstOrThrow();

    expect(outcome.success).toBe(true);
    expect(outcome.state).toBe('settled');
  });

  it('leaves a decision alone while it is still inside its lease', async () => {
    // A decision dispatched two seconds ago is probably still in flight in a healthy
    // process. Reconciling it would race the worker that owns it.
    const txn = await seedOne('lease');
    const gateway = scriptedGateway({ succeed: false, crashAfterCharge: true });

    await attemptOnce(txn, gateway, 'lease');

    const report = await reconcileStranded(
      { db, gateway, policy },
      { batchId: txn.batchId, now: AT, olderThanMs: 30_000 },
    );

    expect(report.settled).toBe(0);
    expect(report.redispatched).toBe(0);
  });

  it('is safe to run twice — the second pass finds nothing to do', async () => {
    const txn = await seedOne('twice');
    const gateway = scriptedGateway({ succeed: false, crashAfterCharge: true });
    await attemptOnce(txn, gateway, 'twice');

    const later = new Date(AT.getTime() + 60_000);
    const first = await reconcileStranded(
      { db, gateway, policy },
      { batchId: txn.batchId, now: later, olderThanMs: 0 },
    );
    const second = await reconcileStranded(
      { db, gateway, policy },
      { batchId: txn.batchId, now: later, olderThanMs: 0 },
    );

    expect(first.settled).toBe(1);
    // Idempotent by state, not by luck: the first pass moved the decision to `settled`,
    // and the claim query only selects `pending`.
    expect(second.settled).toBe(0);
    expect(gateway.calls()).toBe(1);
  });

  it('records a failed attempt honestly, fee spent and nothing recovered', async () => {
    const txn = await seedOne('failed');
    const gateway = scriptedGateway({ succeed: false, crashAfterCharge: true });
    await attemptOnce(txn, gateway, 'failed');

    await reconcileStranded(
      { db, gateway, policy },
      { batchId: txn.batchId, now: new Date(AT.getTime() + 60_000), olderThanMs: 0 },
    );

    const outcome = await db
      .selectFrom('outcome')
      .innerJoin('decision', 'decision.id', 'outcome.decision_id')
      .select(['outcome.success', 'outcome.fee_paise', 'outcome.recovered_paise'])
      .where('decision.txn_id', '=', txn.txnId)
      .executeTakeFirstOrThrow();

    expect(outcome.success).toBe(false);
    // The fee is charged either way. This is the whole reason net value differs from
    // recovery rate, and the reason retry-everything bleeds.
    expect(outcome.fee_paise).toBe('350');
    expect(outcome.recovered_paise).toBe('0');
  });

  it('writes an audit row marking the settlement as reconciled', async () => {
    const txn = await seedOne('audited');
    const gateway = scriptedGateway({ succeed: true, crashAfterCharge: true });
    await attemptOnce(txn, gateway, 'audited');

    await reconcileStranded(
      { db, gateway, policy },
      { batchId: txn.batchId, now: new Date(AT.getTime() + 60_000), olderThanMs: 0 },
    );

    const events = await db
      .selectFrom('audit')
      .select(['event_type', 'actor'])
      .where('batch_id', '=', txn.batchId)
      .orderBy('id', 'asc')
      .execute();

    const types = events.map((event) => event.event_type);
    expect(types).toContain('attempt.dispatched');
    // Distinguished from a normal settlement, and attributed to the worker rather than the
    // policy engine — so "which of these outcomes came back through recovery?" is a query
    // rather than an investigation.
    expect(types).toContain('attempt.reconciled');

    const reconciled = events.find((event) => event.event_type === 'attempt.reconciled');
    expect(reconciled?.actor).toBe('worker');
  });
});
