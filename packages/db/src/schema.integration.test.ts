import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createDb, isDatabaseReachable, type Db } from './client.js';

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
 * The schema's guarantees, tested against a real Postgres.
 *
 * These cannot be tested against a mock, and that is precisely why they are worth
 * testing: every assertion below is enforced by a trigger, a CHECK constraint or a
 * partial unique index, so a mocked database would pass all of them while the real one
 * silently permitted a rewritten audit trail.
 *
 * Requires the stack to be up (`docker compose up -d`) and `pnpm db:migrate` to have run.
 *
 * Fixtures use a random discriminator rather than cleaning up after themselves, because
 * three of the tables under test are append-only — a test that could delete its own rows
 * would be proving the opposite of the point.
 */

let db: Db;
let close: () => Promise<void>;

/** Unique per run, so repeated runs never collide on batch(seed, arm, world). */
const RUN = Math.floor(Math.random() * 1_000_000_000);

/**
 * A 64-character hex idempotency key, scoped to this run.
 *
 * Not a constant. An earlier version used literals like `'a'.repeat(64)`, which meant the
 * whole suite only passed against a freshly reset database: on the second run the *first*
 * insert collided, so the test asserting that a duplicate is refused failed at setup
 * instead of at its assertion. A suite that needs a pristine database to pass is a suite
 * that will fail in front of whoever runs it second.
 */
const keyFor = (n: number): string =>
  (RUN.toString(16).padStart(8, '0') + n.toString(16).padStart(8, '0')).repeat(4);

interface Fixture {
  readonly customerId: string;
  readonly batchId: string;
  readonly txnId: string;
}

let fx: Fixture;

beforeAll(async () => {
  ({ db, close } = createDb());

  const customer = await db
    .insertInto('customer')
    .values({ external_ref: `it-${RUN}`, display_name: 'Integration Fixture' })
    .returning('id')
    .executeTakeFirstOrThrow();

  const batch = await db
    .insertInto('batch')
    .values({ seed: RUN, arm: 'rc' })
    .returning('id')
    .executeTakeFirstOrThrow();

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

  const txn = await db
    .insertInto('txn')
    .values({
      logical_ref: '0',
      batch_id: batch.id,
      customer_id: customer.id,
      amount_paise: '487213',
      margin_bps: 1800,
      rail: 'card',
      failed_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  fx = { customerId: customer.id, batchId: batch.id, txnId: txn.id };
});

afterAll(async () => {
  await close();
});

/** A fired decision, which requires an attempt number and an idempotency key. */
function firedDecision(overrides: {
  readonly traceId: string;
  readonly attemptNo: number;
  readonly key: string;
  readonly state?: 'planned' | 'pending' | 'settled';
}) {
  return {
    txn_id: fx.txnId,
    batch_id: fx.batchId,
    trace_id: overrides.traceId,
    policy_version: 1,
    reason_code: 'insufficient_funds',
    verdict: 'fire' as const,
    planned_action: 'retry' as const,
    // Required by `decision_fire_has_timing`: a fired decision must record which timing
    // bucket it chose, because reconciliation rebuilds the gateway request from it.
    planned_timing: 'salary_window' as const,
    ev_p_bps: 4500,
    ev_value_paise: '87698',
    ev_cost_paise: '350',
    ev_net_paise: '39114',
    attempt_no: overrides.attemptNo,
    idempotency_key: overrides.key,
    ...(overrides.state === undefined ? {} : { state: overrides.state }),
  };
}

describe.skipIf(!DATABASE_UP)('append-only tables reject rewriting history', () => {
  it('refuses UPDATE, DELETE and TRUNCATE on audit', async () => {
    const trace = `audit-${RUN}`;
    await db
      .insertInto('audit')
      .values({ trace_id: trace, event_type: 'test', actor: 'policy_engine' })
      .execute();

    await expect(
      db.updateTable('audit').set({ event_type: 'tampered' }).where('trace_id', '=', trace).execute(),
    ).rejects.toThrow(/append-only/);

    await expect(
      db.deleteFrom('audit').where('trace_id', '=', trace).execute(),
    ).rejects.toThrow(/append-only/);

    // TRUNCATE bypasses row-level triggers entirely. It needs its own statement-level
    // trigger, and omitting it is the gap that lets a stray `truncate audit` succeed
    // silently in most "append-only" implementations.
    await expect(sql`truncate audit`.execute(db)).rejects.toThrow(/append-only/);
  });

  it('refuses to let a withdrawn consent be un-withdrawn', async () => {
    await db
      .insertInto('consent_event')
      .values({ customer_id: fx.customerId, channel: 'sms', state: 'opt_in', source: 'checkout' })
      .execute();
    await db
      .insertInto('consent_event')
      .values({ customer_id: fx.customerId, channel: 'sms', state: 'opt_out', source: 'stop_reply' })
      .execute();

    // The derived view reflects the latest event, so withdrawal takes effect without
    // anything being mutated.
    const current = await db
      .selectFrom('consent_current')
      .select(['channel', 'state'])
      .where('customer_id', '=', fx.customerId)
      .executeTakeFirstOrThrow();
    expect(current.state).toBe('opt_out');

    // And there is no UPDATE that could reverse it.
    await expect(
      db
        .updateTable('consent_event')
        .set({ state: 'opt_in' })
        .where('customer_id', '=', fx.customerId)
        .execute(),
    ).rejects.toThrow(/append-only/);
  });
});

describe.skipIf(!DATABASE_UP)('decisions: fired actions are identified, refusals are not', () => {
  it('refuses a fired decision with no idempotency key', async () => {
    await expect(
      db
        .insertInto('decision')
        .values({
          ...firedDecision({ traceId: `bad-${RUN}`, attemptNo: 1, key: keyFor(9) }),
          idempotency_key: null,
        })
        .execute(),
    ).rejects.toThrow(/decision_fire_is_identified/);
  });

  it('enforces invariant I2 — the same idempotency key cannot be used twice', async () => {
    const key = keyFor(1);
    await db
      .insertInto('decision')
      .values(firedDecision({ traceId: `i2a-${RUN}`, attemptNo: 1, key }))
      .execute();

    // This is what makes crash-resume safe: a restarted worker recomputes the same key
    // from (txn, attempt_no, policy_version) and the database refuses the duplicate,
    // rather than the customer being charged twice.
    await expect(
      db
        .insertInto('decision')
        .values(firedDecision({ traceId: `i2b-${RUN}`, attemptNo: 2, key }))
        .execute(),
    ).rejects.toThrow(/decision_idempotency_key_uq/);
  });

  it('allows many refusals on one transaction without consuming an attempt number', async () => {
    // The reason this table is called `decision` and not `attempt`. Refusals must be
    // recorded with full rigour, but they must not spend the retry budget — otherwise
    // "attempt 2 of 2" starts counting the times the engine declined to act.
    const base = {
      txn_id: fx.txnId,
      batch_id: fx.batchId,
      policy_version: 1,
      reason_code: 'insufficient_funds',
      planned_action: 'none' as const,
      ev_value_paise: '87698',
      ev_cost_paise: '350',
    };

    await db
      .insertInto('decision')
      .values([
        {
          ...base,
          trace_id: `ref1-${RUN}`,
          verdict: 'refuse_ev' as const,
          refuse_detail: 'expected value below floor',
          // Every refusal names the rule that produced it, not just the prose. The
          // `decision_refusal_names_its_rule` constraint enforces both halves — a refusal
          // must name one and a fired decision must not — which is what makes "the consent
          // bound cost us this much" a query rather than a grep over English sentences.
          refuse_rule: 'ev_floor',
          ev_p_bps: 800,
          ev_net_paise: '-343',
        },
        {
          ...base,
          trace_id: `ref2-${RUN}`,
          verdict: 'refuse_bounds',
          refuse_detail: 'inside quiet hours',
          refuse_rule: 'quiet_hours',
          ev_p_bps: 4500,
          ev_net_paise: '39114',
        },
      ])
      .execute();

    const refusals = await db
      .selectFrom('decision')
      .select(['verdict', 'ev_net_paise', 'attempt_no'])
      .where('txn_id', '=', fx.txnId)
      .where('verdict', 'in', ['refuse_ev', 'refuse_bounds'])
      .execute();

    expect(refusals).toHaveLength(2);
    // Every refusal carries the arithmetic that produced it, which is what lets it
    // explain itself in rupees long after the fact.
    expect(refusals.every((r) => r.attempt_no === null)).toBe(true);
    expect(refusals.some((r) => r.ev_net_paise === '-343')).toBe(true);
  });

  it('refuses a refusal that does not name its rule, and a fired decision that does', async () => {
    // BOTH HALVES, because either one alone is useless.
    //
    // Without the first, "what did the consent bound cost us?" silently omits whichever code
    // path forgot to set the column — and an under-reported compliance cost is exactly the
    // number a reader would rely on. Without the second, a fired decision could carry a rule
    // that refused nothing, and the aggregate would count spend that happened as spend that
    // was declined.
    const base = {
      txn_id: fx.txnId,
      batch_id: fx.batchId,
      policy_version: 1,
      reason_code: 'insufficient_funds',
      planned_action: 'none' as const,
      ev_value_paise: '87698',
      ev_cost_paise: '350',
      ev_p_bps: 800,
      ev_net_paise: '-343',
    };

    await expect(
      db
        .insertInto('decision')
        .values({
          ...base,
          trace_id: `norule-${RUN}`,
          verdict: 'refuse_ev',
          refuse_detail: 'expected value below floor',
          refuse_rule: null,
        })
        .execute(),
    ).rejects.toThrow(/decision_refusal_names_its_rule/);

    await expect(
      db
        .insertInto('decision')
        .values({
          ...base,
          trace_id: `firedrule-${RUN}`,
          verdict: 'fire',
          planned_action: 'retry',
          planned_rail: 'card',
          planned_timing: 'immediate',
          attempt_no: 1,
          idempotency_key: keyFor(9_001),
          refuse_rule: 'consent',
        })
        .execute(),
    ).rejects.toThrow(/decision_refusal_names_its_rule/);
  });
});

describe.skipIf(!DATABASE_UP)('decisions are frozen once written, except along their state machine', () => {
  it('permits planned → pending but refuses settled → pending', async () => {
    const trace = `sm-${RUN}`;
    await db
      .insertInto('decision')
      .values(firedDecision({ traceId: trace, attemptNo: 3, key: keyFor(2) }))
      .execute();

    await db.updateTable('decision').set({ state: 'pending' }).where('trace_id', '=', trace).execute();
    const advanced = await db
      .selectFrom('decision')
      .select('state')
      .where('trace_id', '=', trace)
      .executeTakeFirstOrThrow();
    expect(advanced.state).toBe('pending');

    await db.updateTable('decision').set({ state: 'settled' }).where('trace_id', '=', trace).execute();

    // Without this, a crash-resume bug could re-dispatch an attempt that already
    // succeeded — the double charge arriving through a different door than the one the
    // idempotency key guards.
    await expect(
      db.updateTable('decision').set({ state: 'pending' }).where('trace_id', '=', trace).execute(),
    ).rejects.toThrow(/settled is terminal/);
  });

  it('refuses to rewrite the expected-value arithmetic after the outcome is known', async () => {
    const trace = `frozen-${RUN}`;
    await db
      .insertInto('decision')
      .values(firedDecision({ traceId: trace, attemptNo: 4, key: keyFor(3) }))
      .execute();

    // Re-scoring a decision after seeing how it turned out is how a reported total stops
    // meaning anything. The justification is history; only `state` moves.
    await expect(
      db
        .updateTable('decision')
        .set({ ev_net_paise: '9999999' })
        .where('trace_id', '=', trace)
        .execute(),
    ).rejects.toThrow(/immutable once written/);
  });
});

describe.skipIf(!DATABASE_UP)('money cannot be misreported', () => {
  it('refuses an outcome that recovered money without succeeding', async () => {
    const trace = `out-${RUN}`;
    await db
      .insertInto('decision')
      .values(firedDecision({ traceId: trace, attemptNo: 5, key: keyFor(4) }))
      .execute();
    const decision = await db
      .selectFrom('decision')
      .select('id')
      .where('trace_id', '=', trace)
      .executeTakeFirstOrThrow();

    await expect(
      db
        .insertInto('outcome')
        .values({ decision_id: decision.id, success: false, recovered_paise: '5000' })
        .execute(),
    ).rejects.toThrow(/outcome_recovery_requires_success/);
  });

  it('refuses to spend past the batch fee budget', async () => {
    await db
      .insertInto('batch_budget')
      .values({ batch_id: fx.batchId, fee_budget_paise: '1000', fee_spent_paise: '0' })
      .execute();

    // The ceiling is a database constraint, not only an application check. If a code path
    // ever forgets to consult the policy, the transaction still aborts.
    await expect(
      db
        .updateTable('batch_budget')
        .set({ fee_spent_paise: '1001' })
        .where('batch_id', '=', fx.batchId)
        .execute(),
    ).rejects.toThrow(/batch_budget_not_exceeded/);
  });

  it('refuses a transaction with a non-positive amount', async () => {
    await expect(
      db
        .insertInto('txn')
        .values({
          logical_ref: '1',
          batch_id: fx.batchId,
          customer_id: fx.customerId,
          amount_paise: '0',
          margin_bps: 1800,
          rail: 'card',
          failed_at: new Date(),
        })
        .execute(),
    ).rejects.toThrow(/txn_amount_paise_check/);
  });
});

describe.skipIf(!DATABASE_UP)('compliance constraints', () => {
  it('refuses a reason code that is both never-contact and notifiable', async () => {
    // A contradictory open-world proposal is rejected by the database rather than by a
    // reviewer's attention.
    await expect(
      db
        .insertInto('reason_code')
        .values({
          code: `contradictory_${RUN}`,
          terminal: true,
          notifiable: true,
          never_contact: true,
          note: 'cannot be both',
        })
        .execute(),
    ).rejects.toThrow(/reason_code_contact_coherent/);
  });

  it('refuses to mark a template registered without a DLT registration id', async () => {
    // "Registered" must be a fact, not a label. Without the id, the template is not
    // legal to send on a regulated channel in India.
    await expect(
      db
        .insertInto('message_template')
        .values({
          id: `tpl_bad_${RUN}_v1`,
          family: `bad_${RUN}`,
          channel: 'sms',
          language: 'en',
          body: 'test',
          status: 'registered',
        })
        .execute(),
    ).rejects.toThrow(/template_registered_has_dlt_id/);
  });
});
