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

/** Messages sent to this customer inside the rolling contact window. */
export async function countRecentContacts(
  db: DbOrTx,
  customer: CustomerId,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - CONTACT_WINDOW_DAYS * 86_400_000);

  const row = await db
    .selectFrom('message_send')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('customer_id', '=', customer)
    .where('sent_at', '>=', since)
    .executeTakeFirstOrThrow();

  return Number.parseInt(row.n, 10);
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
  readonly consent: ConsentState;
  readonly template: TemplateRef | null;
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

  const customer = await db
    .selectFrom('customer')
    .select('preferred_language')
    .where('id', '=', txn.customerId)
    .executeTakeFirstOrThrow(() => new Error(`No customer ${txn.customerId}`));

  const templateId = args.policy.forReason(args.reasonCode).template;
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

  return {
    txn,
    attemptNo: history.firedCount + 1,
    hoursSinceLastAttempt:
      history.lastFiredAt === null ? null : hoursBetween(history.lastFiredAt, args.now),
    contactsThisWeek: await countRecentContacts(db, txn.customerId, args.now),
    consent,
    template,
    batchFeeRemaining: (PaiseSchema.parse(budget.fee_budget_paise) -
      PaiseSchema.parse(budget.fee_spent_paise)) as Paise,
  };
}
