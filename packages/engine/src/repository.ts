import {
  PaiseSchema,
  bps,
  customerId as brandCustomerId,
  templateId as brandTemplateId,
  hoursBetween,
  type Bps,
  type Channel,
  type CustomerId,
  type Paise,
  type Rail,
  type RiskClass,
  type TxnId,
} from '@rc/core';
import type { DbOrTx } from '@rc/db';
import type { ConsentState, Policy } from '@rc/policy';
import type { TemplateRef } from './plan.js';

/**
 * Reads the planner needs.
 *
 * Every value here is *observed history* — what actually happened to this transaction and
 * this customer. None of it is a judgement, which is why the planner can stay pure: it is
 * handed facts and returns a decision, and both halves are independently testable.
 *
 * Note what is derived rather than stored: attempt counts, contact counts, and the gap
 * since the last attempt are all computed by query. A maintained counter would be faster
 * and would eventually disagree with the rows it summarises — and a contact ceiling that
 * disagrees with the messages actually sent is worse than no ceiling.
 */

const CONTACT_WINDOW_DAYS = 7;

export interface TxnContext {
  readonly txnId: TxnId;
  readonly batchId: string;
  readonly customerId: CustomerId;
  readonly amount: Paise;
  readonly marginBps: Bps;
  readonly rail: Rail;
  /**
   * Position in the seeded population, identical across worlds.
   *
   * Passed through to the gateway, which keys its outcome draw on it so that every arm
   * faces the same coin flips. Opaque to the engine, which never interprets it.
   */
  readonly logicalRef: string;
  /** What kind of revenue is at risk. Selects the strategy and the value calculation. */
  readonly riskClass: RiskClass;
  /** Remaining billing cycles, for a subscription. Null for every other class. */
  readonly lifetimeCycles: number | null;
  /** Days past due, for a receivable. Null for every other class. */
  readonly daysOverdue: number | null;
  /**
   * Whether a live e-mandate backs the debit.
   *
   * Derived from `mandate_ref` being present rather than from the risk class, because the
   * two genuinely differ: a lapsed mandate has a risk class about mandates and no mandate.
   */
  readonly mandateBacked: boolean;
}

export async function loadTxnContext(db: DbOrTx, txnId: TxnId): Promise<TxnContext> {
  const row = await db
    .selectFrom('txn')
    .select([
      'id',
      'batch_id',
      'customer_id',
      'amount_paise',
      'margin_bps',
      'rail',
      'logical_ref',
      'risk_class',
      'lifetime_cycles',
      'days_overdue',
      'mandate_ref',
    ])
    .where('id', '=', txnId)
    .executeTakeFirstOrThrow(() => new Error(`No transaction ${txnId}`));

  return {
    txnId,
    batchId: row.batch_id,
    customerId: brandCustomerId(row.customer_id),
    amount: PaiseSchema.parse(row.amount_paise),
    marginBps: bps(row.margin_bps),
    rail: row.rail,
    logicalRef: row.logical_ref,
    riskClass: row.risk_class,
    lifetimeCycles: row.lifetime_cycles,
    daysOverdue: row.days_overdue,
    mandateBacked: row.mandate_ref !== null && row.risk_class !== 'mandate_lapsed',
  };
}

export interface AttemptHistory {
  /** Attempts that actually FIRED. Refusals are excluded — they spend nothing. */
  readonly firedCount: number;
  readonly lastFiredAt: Date | null;
}

/**
 * How many attempts have fired, and when the last one did.
 *
 * `verdict = 'fire'` is the filter, and it is the reason the table is called `decision`
 * rather than `attempt`: refusals are recorded with equal rigour but must not consume the
 * retry budget, since declining is what preserves it.
 */
export async function loadAttemptHistory(db: DbOrTx, txnId: TxnId): Promise<AttemptHistory> {
  const rows = await db
    .selectFrom('decision')
    .select(['evaluated_at'])
    .where('txn_id', '=', txnId)
    .where('verdict', '=', 'fire')
    .orderBy('evaluated_at', 'desc')
    .execute();

  return {
    firedCount: rows.length,
    lastFiredAt: rows[0]?.evaluated_at ?? null,
  };
}

/**
 * Messages sent to this customer inside the rolling contact window.
 *
 * `channel` narrows it to one channel, which is how the voice ceiling is enforced: calls are
 * counted separately and capped harder, because a second call in a week is not twice the
 * recovery — it is a complaint.
 */
export async function countRecentContacts(
  db: DbOrTx,
  customer: CustomerId,
  now: Date,
  channel?: Channel,
): Promise<number> {
  const since = new Date(now.getTime() - CONTACT_WINDOW_DAYS * 86_400_000);

  let query = db
    .selectFrom('message_send')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('customer_id', '=', customer)
    .where('sent_at', '>=', since);

  if (channel !== undefined) query = query.where('channel', '=', channel);

  const row = await query.executeTakeFirstOrThrow();
  return Number.parseInt(row.n, 10);
}

/**
 * When a pre-debit notification was last actually DELIVERED for this transaction.
 *
 * Read from `message_send`, not from the decision that planned it, and the distinction is
 * the whole value of the check. A pre-debit notice suppressed by quiet hours or by a consent
 * opt-out is a notice that never reached the customer — so the debit that would have
 * followed it is unlawful, even though a `fire` decision exists for the notification step.
 *
 * The consequence is a cascade worth demonstrating: block the message, and the charge 24
 * hours later refuses itself with `pre_debit_notice`.
 */
export async function loadPreDebitNoticeAt(db: DbOrTx, txnId: TxnId): Promise<Date | null> {
  const row = await db
    .selectFrom('message_send')
    .innerJoin('decision', 'decision.id', 'message_send.decision_id')
    .select('message_send.sent_at as sent_at')
    .where('decision.txn_id', '=', txnId)
    .where('decision.planned_action', '=', 'pre_debit_notify')
    .where('decision.verdict', '=', 'fire')
    .orderBy('message_send.sent_at', 'desc')
    .executeTakeFirst();

  return row?.sent_at ?? null;
}

/**
 * The open promise-to-pay on this transaction, if there is one.
 *
 * At most one can exist — a partial unique index enforces it — because two would make "is
 * action suppressed?" depend on which row was read first.
 */
export async function loadOpenPromise(
  db: DbOrTx,
  txnId: TxnId,
): Promise<{ readonly promisedFor: Date; readonly promisedPaise: Paise } | null> {
  const row = await db
    .selectFrom('promise')
    .select(['promised_for', 'promised_paise'])
    .where('txn_id', '=', txnId)
    .where('status', '=', 'open')
    .executeTakeFirst();

  if (row === undefined) return null;
  return {
    promisedFor: row.promised_for,
    promisedPaise: PaiseSchema.parse(row.promised_paise),
  };
}

/**
 * Current consent, from the append-only ledger's derived view.
 *
 * `unknown` when the customer has never expressed a preference for this channel — and
 * `unknown` is not `opt_in`. Treating silence as permission is the default that turns a
 * recovery system into a compliance problem.
 */
export async function loadConsent(
  db: DbOrTx,
  customer: CustomerId,
  channel: Channel,
): Promise<ConsentState> {
  const row = await db
    .selectFrom('consent_current')
    .select('state')
    .where('customer_id', '=', customer)
    .where('channel', '=', channel)
    .executeTakeFirst();

  return row?.state ?? 'unknown';
}

/**
 * Resolve a policy template id to the variant this customer should receive.
 *
 * The policy names one readable template id; this maps it to its family and then to the
 * variant matching the customer's language. Keeping the language decision here rather than
 * in the policy is what makes Hinglish a real selection instead of a second row nobody
 * picks — and it keeps the policy YAML legible, since a per-language entry per reason code
 * would double its size to express one fact about customers.
 *
 * Falls back to English when no variant exists for the customer's language: sending the
 * wrong script is worse than sending the default, and silently sending nothing is worse
 * than both.
 */
export async function loadTemplate(
  db: DbOrTx,
  id: string,
  language: 'en' | 'hi_latn' = 'en',
): Promise<TemplateRef | null> {
  const named = await db
    .selectFrom('message_template')
    .select(['id', 'family', 'channel', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (named === undefined) return null;

  const variant =
    language === 'en'
      ? named
      : ((await db
          .selectFrom('message_template')
          .select(['id', 'family', 'channel', 'status'])
          .where('family', '=', named.family)
          .where('channel', '=', named.channel)
          .where('language', '=', language)
          .where('status', '=', 'registered')
          .executeTakeFirst()) ?? named);

  return {
    id: brandTemplateId(variant.id),
    channel: variant.channel,
    // Only a registered template may be sent. A draft awaiting DLT review is a real row
    // with a real body and it is still not legal to send, so registration is surfaced as
    // its own fact rather than inferred from existence.
    registered: variant.status === 'registered',
  };
}

export interface PlanContext {
  readonly txn: TxnContext;
  readonly attemptNo: number;
  readonly hoursSinceLastAttempt: number | null;
  readonly contactsThisWeek: number;
  readonly callsThisWeek: number;
  readonly consent: ConsentState;
  readonly template: TemplateRef | null;
  readonly onNcprRegistry: boolean;
  readonly hoursSincePreDebitNotice: number | null;
  readonly openPromiseDueAt: Date | null;
  readonly batchFeeRemaining: Paise;
}

/**
 * Assemble everything `planNext` needs, apart from the policy and the priors.
 *
 * Deliberately reads the fee budget WITHOUT locking. The lock belongs in the transaction
 * that spends, not the one that plans — holding it across planning would serialise the
 * whole batch behind one row. The consequence is that the budget read here can be stale,
 * so `executeDecision` re-checks it after taking the lock and downgrades the plan if
 * another worker got there first.
 */
export async function loadPlanContext(
  db: DbOrTx,
  args: {
    readonly txnId: TxnId;
    readonly now: Date;
    readonly policy: Policy;
    readonly reasonCode: Parameters<Policy['forReason']>[0];
  },
): Promise<PlanContext> {
  const txn = await loadTxnContext(db, args.txnId);
  const history = await loadAttemptHistory(db, args.txnId);
  const attemptNo = history.firedCount + 1;

  const customer = await db
    .selectFrom('customer')
    .select(['preferred_language', 'on_ncpr_registry'])
    .where('id', '=', txn.customerId)
    .executeTakeFirstOrThrow(() => new Error(`No customer ${txn.customerId}`));

  // The STEP's template wins over the reason code's default, which is how an escalation
  // ladder climbs channels: naming a voice template at step three is the entire mechanism,
  // because the template carries its own channel. Falling back to the reason default keeps
  // every unremarkable step's config to one line.
  const step = args.policy.scheduleEntry(args.reasonCode, attemptNo, txn.riskClass);
  const reason = args.policy.forReason(args.reasonCode, txn.riskClass);
  const templateId = step?.template ?? reason.template;

  const template =
    templateId === undefined
      ? null
      : await loadTemplate(db, templateId, customer.preferred_language);

  const consent =
    template === null ? 'unknown' : await loadConsent(db, txn.customerId, template.channel);

  const budget = await db
    .selectFrom('batch_budget')
    .select(['fee_budget_paise', 'fee_spent_paise'])
    .where('batch_id', '=', txn.batchId)
    .executeTakeFirstOrThrow(() => new Error(`No budget row for batch ${txn.batchId}`));

  const noticeAt = await loadPreDebitNoticeAt(db, args.txnId);
  const promise = await loadOpenPromise(db, args.txnId);

  return {
    txn,
    attemptNo,
    hoursSinceLastAttempt:
      history.lastFiredAt === null ? null : hoursBetween(history.lastFiredAt, args.now),
    contactsThisWeek: await countRecentContacts(db, txn.customerId, args.now),
    callsThisWeek: await countRecentContacts(db, txn.customerId, args.now, 'voice'),
    consent,
    template,
    onNcprRegistry: customer.on_ncpr_registry,
    hoursSincePreDebitNotice: noticeAt === null ? null : hoursBetween(noticeAt, args.now),
    openPromiseDueAt: promise?.promisedFor ?? null,
    batchFeeRemaining: (PaiseSchema.parse(budget.fee_budget_paise) -
      PaiseSchema.parse(budget.fee_spent_paise)) as Paise,
  };
}
