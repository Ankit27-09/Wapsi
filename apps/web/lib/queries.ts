import { PaiseSchema, RISK_CLASSES, ZERO, add, bps, mulBps, sub, type Paise, type RiskClass } from '@rc/core';
import { loadPriorTable } from '@rc/policy';
import { db } from './db';

/**
 * The published priors, loaded once per server process.
 *
 * Read only to answer "was this cause recoverable at all" — the denominator of the recovery
 * rate. The console displays decisions the engine already made; it does not make any, so it
 * has no business consulting a probability for anything else.
 */
const PRIORS = loadPriorTable();

/**
 * Reads for the console.
 *
 * All aggregation happens here in TypeScript rather than in SQL, for the same reason the
 * eval harness does it: `value = recovered × margin_bps` must use the identical rounding as
 * the expected-value gate that decided the action. Postgres bigint division truncates while
 * `mulBps` rounds half away from zero, and a page that disagreed with the engine by a paise
 * per row would be worse than no page at all.
 */

export const SEED = Number.parseInt(process.env['EVAL_SEED'] ?? '42', 10);
const WORLD = 'base';

export interface ArmRow {
  readonly arm: string;
  readonly label: string;
  readonly recovered: number;
  readonly recoverable: number;
  readonly rateBps: number;
  readonly valueRecovered: Paise;
  readonly cost: Paise;
  readonly net: Paise;
  readonly attemptsFired: number;
  readonly negativeEvAttempts: number;
}

const ARM_LABELS: Readonly<Record<string, string>> = {
  b0: 'Do nothing',
  b1: 'Retry all, immediately',
  b2: 'Fixed-schedule dunning',
  b3_oracle: 'Oracle (ceiling)',
  rc: 'Recovery Controller',
};

export async function loadArms(): Promise<readonly ArmRow[]> {
  const batches = await db()
    .selectFrom('batch')
    .select(['id', 'arm'])
    .where('seed', '=', SEED)
    .where('world', '=', WORLD)
    .execute();

  const rows: ArmRow[] = [];

  for (const batch of batches) {
    const txns = await db()
      .selectFrom('txn')
      .innerJoin('failure_event', 'failure_event.txn_id', 'txn.id')
      .select(['txn.id as id', 'txn.margin_bps as margin_bps', 'failure_event.raw as raw'])
      .where('txn.batch_id', '=', batch.id)
      .execute();

    const marginByTxn = new Map(txns.map((t) => [t.id, t.margin_bps]));
    const recoverable = txns.filter((t) => isRecoverable(trueCodeOf(t.raw))).length;

    const outcomes = await db()
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

    let value = ZERO;
    let fees = ZERO;
    let negativeEv = 0;
    const recoveredTxns = new Set<string>();

    for (const row of outcomes) {
      fees = add(fees, PaiseSchema.parse(row.fee_paise));
      if (PaiseSchema.parse(row.ev_net_paise) < ZERO) negativeEv += 1;
      if (!row.success) continue;

      const margin = marginByTxn.get(row.txn_id) ?? 0;
      value = add(value, mulBps(PaiseSchema.parse(row.recovered_paise), bps(margin)));
      recoveredTxns.add(row.txn_id);
    }

    const messages = await db()
      .selectFrom('message_send')
      .innerJoin('decision', 'decision.id', 'message_send.decision_id')
      .select('message_send.cost_paise as cost_paise')
      .where('decision.batch_id', '=', batch.id)
      .execute();

    const messageCost = messages.reduce(
      (total, m) => add(total, PaiseSchema.parse(m.cost_paise)),
      ZERO,
    );
    const cost = add(fees, messageCost);

    rows.push({
      arm: batch.arm,
      label: ARM_LABELS[batch.arm] ?? batch.arm,
      recovered: recoveredTxns.size,
      recoverable,
      rateBps: recoverable === 0 ? 0 : Math.round((recoveredTxns.size / recoverable) * 10_000),
      valueRecovered: value,
      cost,
      net: sub(value, cost),
      attemptsFired: outcomes.length,
      negativeEvAttempts: negativeEv,
    });
  }

  const order = ['b0', 'b1', 'b2', 'b3_oracle', 'rc'];
  return rows.sort((a, b) => order.indexOf(a.arm) - order.indexOf(b.arm));
}

export interface ExceptionRow {
  readonly id: string;
  readonly reasonCode: string;
  readonly verdict: string;
  readonly detail: string;
  readonly pBps: number;
  readonly value: Paise;
  readonly cost: Paise;
  readonly net: Paise;
  readonly amount: Paise;
  readonly marginBps: number;
  readonly traceId: string;
}

/**
 * The refusal queue.
 *
 * Every row carries the arithmetic that produced it, which is the entire reason the decision
 * table records actions it declined to take. A refusal that cannot say what it would have
 * been worth is a log line; one that can is an audit record.
 */
export async function loadExceptions(verdict?: string): Promise<readonly ExceptionRow[]> {
  let query = db()
    .selectFrom('decision')
    .innerJoin('batch', 'batch.id', 'decision.batch_id')
    .innerJoin('txn', 'txn.id', 'decision.txn_id')
    .select([
      'decision.id as id',
      'decision.reason_code as reason_code',
      'decision.verdict as verdict',
      'decision.refuse_detail as refuse_detail',
      'decision.ev_p_bps as ev_p_bps',
      'decision.ev_value_paise as ev_value_paise',
      'decision.ev_cost_paise as ev_cost_paise',
      'decision.ev_net_paise as ev_net_paise',
      'decision.trace_id as trace_id',
      'txn.amount_paise as amount_paise',
      'txn.margin_bps as margin_bps',
    ])
    .where('batch.seed', '=', SEED)
    .where('batch.arm', '=', 'rc')
    .where('batch.world', '=', WORLD)
    .where('decision.verdict', '!=', 'fire')
    .orderBy('decision.ev_net_paise', 'desc')
    .limit(400);

  if (verdict !== undefined && verdict !== 'all') {
    query = query.where('decision.verdict', '=', verdict as 'refuse_ev');
  }

  const rows = await query.execute();

  return rows.map((row) => ({
    id: row.id,
    reasonCode: row.reason_code,
    verdict: row.verdict,
    detail: row.refuse_detail ?? '',
    pBps: row.ev_p_bps,
    value: PaiseSchema.parse(row.ev_value_paise),
    cost: PaiseSchema.parse(row.ev_cost_paise),
    net: PaiseSchema.parse(row.ev_net_paise),
    amount: PaiseSchema.parse(row.amount_paise),
    marginBps: row.margin_bps,
    traceId: row.trace_id,
  }));
}

export interface InboxRow {
  readonly id: number;
  readonly customer: string;
  readonly language: string;
  readonly channel: string;
  readonly templateId: string;
  readonly dltId: string | null;
  readonly body: string;
  readonly costPaise: Paise;
  readonly sentAt: Date;
}

/** What customers actually received, and through which registered template. */
export async function loadInbox(): Promise<readonly InboxRow[]> {
  const rows = await db()
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .innerJoin('batch', 'batch.id', 'decision.batch_id')
    .innerJoin('customer', 'customer.id', 'message_send.customer_id')
    .innerJoin('message_template', 'message_template.id', 'message_send.template_id')
    .select([
      'message_send.id as id',
      'customer.display_name as customer',
      'customer.preferred_language as language',
      'message_send.channel as channel',
      'message_send.template_id as template_id',
      'message_template.dlt_template_id as dlt_template_id',
      'message_template.body as body',
      'message_send.cost_paise as cost_paise',
      'message_send.sent_at as sent_at',
    ])
    .where('batch.seed', '=', SEED)
    .where('batch.world', '=', WORLD)
    .orderBy('message_send.sent_at', 'asc')
    .limit(120)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    customer: row.customer,
    language: row.language,
    channel: row.channel,
    templateId: row.template_id,
    dltId: row.dlt_template_id,
    body: row.body,
    costPaise: PaiseSchema.parse(row.cost_paise),
    sentAt: row.sent_at,
  }));
}

/**
 * Contacts that were BLOCKED, and by which bound.
 *
 * Shown alongside the inbox on purpose. A compliance layer is only demonstrable if you can
 * see what it stopped, and every one of these is a message the system chose not to send.
 */
export async function loadBlockedContacts(): Promise<
  readonly { readonly rule: string; readonly count: number }[]
> {
  const rows = await db()
    .selectFrom('audit')
    .innerJoin('batch', 'batch.id', 'audit.batch_id')
    .select(['audit.payload as payload'])
    .where('batch.seed', '=', SEED)
    .where('batch.arm', '=', 'rc')
    .where('batch.world', '=', WORLD)
    .where('audit.event_type', 'in', ['decision.refused', 'decision.escalated'])
    .execute();

  const counts = new Map<string, number>();
  for (const row of rows) {
    const payload = row.payload as { contact_blocked?: string | null } | null;
    const rule = payload?.contact_blocked;
    if (typeof rule !== 'string' || rule === 'not_scheduled') continue;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);
}

export interface AuditRow {
  readonly id: number;
  readonly traceId: string;
  readonly eventType: string;
  readonly actor: string;
  readonly rationale: string | null;
  readonly occurredAt: Date;
  readonly policyVersion: number | null;
}

export async function loadAudit(traceId?: string): Promise<readonly AuditRow[]> {
  let query = db()
    .selectFrom('audit')
    .innerJoin('batch', 'batch.id', 'audit.batch_id')
    .select([
      'audit.id as id',
      'audit.trace_id as trace_id',
      'audit.event_type as event_type',
      'audit.actor as actor',
      'audit.rationale as rationale',
      'audit.occurred_at as occurred_at',
      'audit.policy_version as policy_version',
    ])
    .where('batch.seed', '=', SEED)
    .where('batch.arm', '=', 'rc')
    .where('batch.world', '=', WORLD)
    .orderBy('audit.id', 'desc')
    .limit(300);

  if (traceId !== undefined && traceId !== '') {
    query = query.where('audit.trace_id', '=', traceId);
  }

  const rows = await query.execute();

  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    eventType: row.event_type,
    actor: row.actor,
    rationale: row.rationale,
    occurredAt: row.occurred_at,
    policyVersion: row.policy_version,
  }));
}

/** Per-cause breakdown for the overview. */
export async function loadByReasonCode(): Promise<
  readonly {
    readonly code: string;
    readonly fired: number;
    readonly recovered: number;
    readonly refused: number;
  }[]
> {
  const decisions = await db()
    .selectFrom('decision')
    .innerJoin('batch', 'batch.id', 'decision.batch_id')
    .leftJoin('outcome', 'outcome.decision_id', 'decision.id')
    .select([
      'decision.reason_code as reason_code',
      'decision.verdict as verdict',
      'outcome.success as success',
    ])
    .where('batch.seed', '=', SEED)
    .where('batch.arm', '=', 'rc')
    .where('batch.world', '=', WORLD)
    .execute();

  const map = new Map<string, { fired: number; recovered: number; refused: number }>();

  for (const row of decisions) {
    const entry = map.get(row.reason_code) ?? { fired: 0, recovered: 0, refused: 0 };
    if (row.verdict === 'fire') {
      entry.fired += 1;
      if (row.success === true) entry.recovered += 1;
    } else {
      entry.refused += 1;
    }
    map.set(row.reason_code, entry);
  }

  return [...map.entries()]
    .map(([code, value]) => ({ code, ...value }))
    .sort((a, b) => b.fired + b.refused - (a.fired + a.refused));
}

export interface RiskClassRow {
  readonly riskClass: RiskClass;
  readonly transactions: number;
  readonly recovered: number;
  readonly fired: number;
  readonly refused: number;
  readonly valueRecovered: Paise;
  readonly cost: Paise;
  readonly net: Paise;
}

/**
 * The controller's results per risk class.
 *
 * The table that answers the question a blended figure cannot: does one engine actually
 * generalise across five kinds of revenue at risk, or does it work on payments and lose money
 * on receivables? The aggregate is exactly where a per-class failure would hide.
 */
export async function loadByRiskClass(): Promise<readonly RiskClassRow[]> {
  const batch = await db()
    .selectFrom('batch')
    .select('id')
    .where('seed', '=', SEED)
    .where('arm', '=', 'rc')
    .where('world', '=', WORLD)
    .executeTakeFirst();

  if (batch === undefined) return [];

  const txns = await db()
    .selectFrom('txn')
    .select(['id', 'margin_bps', 'risk_class'])
    .where('batch_id', '=', batch.id)
    .execute();

  const classByTxn = new Map(txns.map((t) => [t.id, t.risk_class]));
  const marginByTxn = new Map(txns.map((t) => [t.id, t.margin_bps]));

  const acc = new Map(
    RISK_CLASSES.map((riskClass) => [
      riskClass,
      {
        transactions: 0,
        recovered: 0,
        fired: 0,
        refused: 0,
        valueRecovered: ZERO,
        cost: ZERO,
      },
    ]),
  );

  for (const txn of txns) {
    const slice = acc.get(txn.risk_class);
    if (slice !== undefined) slice.transactions += 1;
  }

  const decisions = await db()
    .selectFrom('decision')
    .leftJoin('outcome', 'outcome.decision_id', 'decision.id')
    .leftJoin('message_send', 'message_send.decision_id', 'decision.id')
    .select([
      'decision.txn_id as txn_id',
      'decision.verdict as verdict',
      'outcome.success as success',
      'outcome.fee_paise as fee_paise',
      'outcome.recovered_paise as recovered_paise',
      'message_send.cost_paise as message_cost_paise',
    ])
    .where('decision.batch_id', '=', batch.id)
    .execute();

  for (const row of decisions) {
    const slice = acc.get(classByTxn.get(row.txn_id) ?? 'payment_failure');
    if (slice === undefined) continue;

    if (row.verdict === 'fire') slice.fired += 1;
    else slice.refused += 1;

    if (row.fee_paise !== null) {
      slice.cost = add(slice.cost, PaiseSchema.parse(row.fee_paise));
    }
    if (row.message_cost_paise !== null) {
      slice.cost = add(slice.cost, PaiseSchema.parse(row.message_cost_paise));
    }

    if (row.success === true && row.recovered_paise !== null) {
      const margin = marginByTxn.get(row.txn_id);
      if (margin === undefined) continue;
      slice.recovered += 1;
      slice.valueRecovered = add(
        slice.valueRecovered,
        mulBps(PaiseSchema.parse(row.recovered_paise), bps(margin)),
      );
    }
  }

  // Every class is returned, including empty ones. An absent row reads as "not implemented";
  // a zero row reads as "nothing to do", and those are different claims to be making.
  return RISK_CLASSES.map((riskClass) => {
    const slice = acc.get(riskClass);
    if (slice === undefined) throw new Error(`unreachable: no accumulator for ${riskClass}`);
    return {
      riskClass,
      transactions: slice.transactions,
      recovered: slice.recovered,
      fired: slice.fired,
      refused: slice.refused,
      valueRecovered: slice.valueRecovered,
      cost: slice.cost,
      net: sub(slice.valueRecovered, slice.cost),
    };
  });
}

// ---------------------------------------------------------------------------

function trueCodeOf(raw: unknown): string {
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  const simulator = (parsed as { simulator?: { true_reason_code?: unknown } } | null)?.simulator;
  return typeof simulator?.true_reason_code === 'string' ? simulator.true_reason_code : 'unknown';
}

/**
 * Whether the published evidence offers ANY path to recovering this cause.
 *
 * The denominator of the recovery rate, and it reads the real prior table rather than a
 * hardcoded list. There used to be a `TERMINAL` set here — a copy of four reason codes from
 * the taxonomy — and it was a copy that went stale the moment the taxonomy grew: thirteen of
 * the eighteen codes are now terminal, because nothing was ever charged on an abandoned
 * checkout or an overdue invoice, and every one of them is recoverable by other means.
 *
 * The stale set therefore counted nine recoverable classes as unrecoverable and inflated the
 * recovery rate this console displays, while the report next to it used the correct
 * denominator. Two numbers on one submission disagreeing about the same batch is worse than
 * either being wrong.
 *
 * Deliberately the same predicate `computeMetrics` uses, from the same table, so the console
 * and the report cannot drift again.
 */
function isRecoverable(code: string): boolean {
  return PRIORS.rows.some((row) => row.reason_code === code && row.p_bps > 0);
}
