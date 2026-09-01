import { bps, deterministicId, type Rail, type ReasonCode } from '@rc/core';
import type { Arm, Db } from '@rc/db';
import { deriveRng, type Rng } from './rng.js';
import { FAILURE_STRINGS, INJECTION_STRINGS, NOVEL_STRINGS } from './strings.js';
import { ensureTemplatesSeeded } from './templates.js';
import { loadTruthModel } from './truth.js';

/**
 * The batch generator.
 *
 * Produces a population of synthetic customers and failed payments, deterministically,
 * from a seed. Every arm of the evaluation runs against an identically-shaped population
 * so that differences in the results are differences in strategy rather than in luck.
 *
 * Nothing here is real. There is no code path by which real customer data enters this
 * system, which is the reason the repository can be public.
 */

// ---------------------------------------------------------------------------
// Fixed epoch
// ---------------------------------------------------------------------------
// `Date.now()` is not used anywhere in generation. If it were, "same seed, same numbers"
// would be false the moment the clock moved, and the reproducibility claim in the README
// is a large part of what this submission offers.
//
// Chosen as a Monday, so that weekday-sensitive behaviour — salary credits clustering
// early in the month — lands predictably relative to the retry windows.
export const SIM_EPOCH = new Date('2026-06-01T04:30:00.000Z');

const GENERATION_SPAN_DAYS = 7;

// ---------------------------------------------------------------------------
// Population shape
// ---------------------------------------------------------------------------

/**
 * Amount tiers, with the contribution margin that goes with each.
 *
 * Margin falls as ticket size rises, which is the real pattern and the reason the EV gate
 * multiplies by margin rather than by the gross amount: a ₹4 lakh B2B invoice at 8% is
 * worth less effort than its size suggests, and a ₹499 subscription at 26% is worth more.
 * A single blended margin would hide exactly the trade-off the gate exists to make.
 *
 * Bounds are paise, and stay well inside `Number.MAX_SAFE_INTEGER`, so generating them as
 * numbers and converting to `bigint` at the boundary is exact.
 */
const AMOUNT_TIERS = [
  { weight: 45, minPaise: 9_900, maxPaise: 99_900, marginBps: 2600 },
  { weight: 35, minPaise: 100_000, maxPaise: 999_900, marginBps: 1900 },
  { weight: 15, minPaise: 1_000_000, maxPaise: 9_999_900, marginBps: 1200 },
  { weight: 5, minPaise: 10_000_000, maxPaise: 50_000_000, marginBps: 800 },
] as const;

/**
 * Reason code mix.
 *
 * `do_not_honour` is weighted heavily on purpose: it is the most common card decline in
 * the world, and a batch that under-represents it would make recovery look far more
 * tractable than it is. Weights sum to 100 for readability.
 */
const REASON_MIX: readonly { readonly item: ReasonCode; readonly weight: number }[] = [
  { item: 'insufficient_funds', weight: 31 },
  { item: 'do_not_honour', weight: 22 },
  { item: 'threeds_timeout', weight: 14 },
  { item: 'mandate_expired', weight: 9 },
  { item: 'issuer_down', weight: 8 },
  { item: 'card_expired', weight: 7 },
  { item: 'network_timeout', weight: 6 },
  { item: 'suspected_fraud_block', weight: 3 },
];

const RAIL_MIX: readonly { readonly item: Rail; readonly weight: number }[] = [
  { item: 'card', weight: 45 },
  { item: 'upi_collect', weight: 25 },
  { item: 'upi_intent', weight: 15 },
  { item: 'netbanking', weight: 10 },
  { item: 'wallet', weight: 5 },
];

/** Share of the batch rendered with a reason string the taxonomy has never seen. */
const NOVEL_SHARE = bps(1200);
/** Share rendered with a string that tries to steer the classifier. */
const INJECTION_SHARE = bps(300);
/** Share recurring, outside the codes that force it. */
const RECURRING_SHARE = bps(3000);

/**
 * Consent, as an Indian merchant's book actually looks.
 *
 * Not everyone has opted in, and the ones who never expressed a preference are the
 * interesting case: `unknown` is not `opt_in`, so they are unmessageable. Seeding a
 * population where every customer had consented would make the consent bound untestable
 * and the compliance layer decorative.
 */
const CONSENT_OPT_IN_SHARE = bps(6000);
const CONSENT_OPT_OUT_SHARE = bps(1500);

/** Share of customers who should receive Hinglish rather than English templates. */
const HINGLISH_SHARE = bps(4000);

/**
 * Default per-transaction fee budget. The policy's own ceiling applies on top.
 *
 * Exported because the in-memory sweep must apply the identical budget. A second copy of
 * this number would let the sweep and the persisted run diverge silently — and the sweep
 * exists to tell you whether the persisted run's conclusion is trustworthy, which it
 * cannot do if it is quietly measuring a differently-constrained system.
 */
export const DEFAULT_FEE_BUDGET_PER_TXN_PAISE = 400;

/** Failures per customer. Above 1 so contact ceilings are genuinely exercised. */
const FAILURES_PER_CUSTOMER = 1.6;

/** Postgres allows 65535 bind parameters per statement; a 300-row insert approaches it. */
const INSERT_CHUNK = 200;

// ---------------------------------------------------------------------------

export interface GenerateOptions {
  readonly seed: number;
  readonly arm: Arm;
  readonly world?: string;
  readonly count?: number;
  readonly policyVersion?: number;
  readonly feeBudgetPerTxnPaise?: number;
}

export interface GeneratedBatch {
  readonly batchId: string;
  readonly seed: number;
  readonly arm: Arm;
  readonly world: string;
  readonly count: number;
  readonly customers: number;
  readonly novelStrings: number;
  readonly injectionStrings: number;
  readonly byReasonCode: Readonly<Record<string, number>>;
}

/** How a reason string was rendered. Read by the ablation, never by the policy. */
type Rendering = 'labelled' | 'novel' | 'injection';

/**
 * One planned failure, before it touches the database.
 *
 * Exported because the sensitivity sweep replays these in memory. Five hundred draws over
 * five arms and three hundred transactions is 750,000 transaction-runs; going through
 * Postgres for each would take hours, and the sweep is only useful if it can run as part of
 * a normal verification pass.
 */
export interface PlannedTxn {
  readonly customerIndex: number;
  readonly amountPaise: number;
  readonly marginBps: number;
  readonly rail: Rail;
  readonly isRecurring: boolean;
  readonly trueCode: ReasonCode;
  readonly gatewayCode: string | null;
  readonly description: string;
  readonly rendering: Rendering;
  readonly failedAt: Date;
}

/**
 * The rail a failure could plausibly have occurred on.
 *
 * Not random for every code: an expired card or an abandoned 3DS challenge only happens
 * on a card, and a lapsed e-mandate only on a collect flow. A `card_expired` failure on a
 * netbanking rail is a transaction that cannot exist, and any strategy evaluated against
 * it would be evaluated against fiction.
 */
function railFor(code: ReasonCode, rng: Rng): Rail {
  switch (code) {
    case 'card_expired':
    case 'threeds_timeout':
      return 'card';
    case 'mandate_expired':
      return 'upi_collect';
    case 'insufficient_funds':
    case 'do_not_honour':
    case 'issuer_down':
    case 'network_timeout':
    case 'suspected_fraud_block':
    case 'unknown':
      return rng.weighted(RAIL_MIX);
  }
}

/**
 * The pure half of generation: what the batch contains, with no persistence.
 *
 * `generateBatch` writes the result of this; the sweep replays it in memory. Sharing the
 * function rather than reimplementing it is the point — a sweep run against a differently
 * generated population would be measuring a different question.
 */
export function planTxns(seed: number, count: number): {
  readonly txns: readonly PlannedTxn[];
  readonly customerIssuers: readonly string[];
} {
  // Independent streams per concern. Without this, adding one draw to the string chooser
  // would reshuffle every amount in the dataset — "same seed, same numbers" would still
  // hold, but no change to one stage could be evaluated in isolation from the others.
  const rngPopulation = deriveRng(seed, 'population');
  const rngAmounts = deriveRng(seed, 'amounts');
  const rngCauses = deriveRng(seed, 'causes');
  const rngStrings = deriveRng(seed, 'strings');
  const rngTiming = deriveRng(seed, 'timing');

  const truth = loadTruthModel();

  const customerCount = Math.max(1, Math.ceil(count / FAILURES_PER_CUSTOMER));
  const customerIssuers = Array.from(
    { length: customerCount },
    () => truth.pickIssuer(rngPopulation).id,
  );

  const txns: PlannedTxn[] = [];

  for (let i = 0; i < count; i += 1) {
    const tier = rngAmounts.weighted(AMOUNT_TIERS.map((t) => ({ item: t, weight: t.weight })));
    const amountPaise = rngAmounts.nextInt(tier.minPaise, tier.maxPaise);

    const trueCode = rngCauses.weighted(REASON_MIX);
    const rail = railFor(trueCode, rngCauses);
    const isRecurring =
      trueCode === 'mandate_expired' ? true : rngCauses.chance(RECURRING_SHARE);

    const rendered = renderDescription(trueCode, rngStrings);

    // Minute granularity across a seven-day window from the fixed epoch.
    const minuteOffset = rngTiming.nextInt(0, GENERATION_SPAN_DAYS * 24 * 60 - 1);
    const failedAt = new Date(SIM_EPOCH.getTime() + minuteOffset * 60_000);

    txns.push({
      customerIndex: i % customerIssuers.length,
      amountPaise,
      marginBps: tier.marginBps,
      rail,
      isRecurring,
      trueCode,
      failedAt,
      ...rendered,
    });
  }

  return { txns, customerIssuers };
}

function renderDescription(
  trueCode: ReasonCode,
  rng: Rng,
): { readonly description: string; readonly gatewayCode: string | null; readonly rendering: Rendering } {
  if (rng.chance(INJECTION_SHARE)) {
    return { description: rng.pick(INJECTION_STRINGS), gatewayCode: null, rendering: 'injection' };
  }

  if (rng.chance(NOVEL_SHARE)) {
    // A novel string still has a real underlying cause, so the cost of quarantining
    // rather than guessing is measurable in rupees instead of being an abstraction.
    return { description: rng.pick(NOVEL_STRINGS), gatewayCode: null, rendering: 'novel' };
  }

  const pool = FAILURE_STRINGS[trueCode];
  if (pool.length === 0) {
    throw new Error(`No failure strings defined for ${trueCode}; cannot render a batch`);
  }
  const chosen = rng.pick(pool);
  return { description: chosen.text, gatewayCode: chosen.code, rendering: 'labelled' };
}

/** Split into fixed-size groups, preserving order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Write one arm's batch to the database.
 *
 * Customers are created per arm, with `external_ref` encoding seed, arm and index. The
 * duplication is deliberate: contact ceilings and consent are per-customer, so sharing
 * customer rows across arms would let one arm's messages consume another arm's budget and
 * the arms would stop being independent. Duplicated rows are the cheap price of isolation.
 */
export async function generateBatch(db: Db, options: GenerateOptions): Promise<GeneratedBatch> {
  const { seed, arm } = options;
  const world = options.world ?? 'base';
  const count = options.count ?? 300;
  const feePerTxn = options.feeBudgetPerTxnPaise ?? DEFAULT_FEE_BUDGET_PER_TXN_PAISE;

  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, got ${count}`);
  }

  const { txns, customerIssuers } = planTxns(seed, count);

  // Reference data the policy depends on. Idempotent, and seeded outside the batch
  // transaction because registered templates are shared across every world rather than
  // owned by one of them.
  await ensureTemplatesSeeded(db);

  // Identity is derived, never assigned by the database.
  //
  // A `gen_random_uuid()` primary key would make the DATA reproducible while leaving
  // IDENTITY random — and the attempt idempotency key hashes the transaction id, which the
  // simulator uses to seed the draw deciding whether an attempt succeeds. Random ids
  // therefore leaked randomness straight into the outcomes: three runs of one seed gave
  // three different net-value figures until this changed. See `deterministicId`.
  const batchId = deterministicId('batch', seed, arm, world);

  return db.transaction().execute(async (tx) => {
    const batch = await tx
      .insertInto('batch')
      .values({
        id: batchId,
        seed,
        arm,
        world,
        record_count: count,
        ...(options.policyVersion === undefined ? {} : { policy_version: options.policyVersion }),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await tx
      .insertInto('batch_budget')
      .values({ batch_id: batch.id, fee_budget_paise: String(feePerTxn * count) })
      .execute();

    // The issuer is encoded in `external_ref` rather than given its own column. It is
    // unobservable to the policy by design, and a first-class column would invite a query
    // that breaches the Chinese wall from the database side, where no lint rule reaches.
    const customerIds = customerIssuers.map((_, index) =>
      deterministicId('customer', seed, arm, world, index),
    );

    // Language and consent are drawn from their own streams, so adding either later cannot
    // reshuffle the amounts or the causes already generated.
    const rngLanguage = deriveRng(seed, 'language');
    const rngConsent = deriveRng(seed, 'consent');

    const languages = customerIds.map(() =>
      rngLanguage.chance(HINGLISH_SHARE) ? ('hi_latn' as const) : ('en' as const),
    );

    for (const part of chunk(
      customerIssuers.map((issuerId, index) => ({
        id: customerIds[index],
        external_ref: `${seed}:${arm}:${world}:${index}:${issuerId}`,
        display_name: `Synthetic Customer ${index + 1}`,
        preferred_language: languages[index],
      })),
      INSERT_CHUNK,
    )) {
      await tx.insertInto('customer').values(part).execute();
    }

    // Consent, as an append-only ledger. Customers with no row are `unknown`, which is not
    // `opt_in` — they are unmessageable, and that population needs to exist or the consent
    // bound is never exercised.
    const consentRows = customerIds.flatMap((customerId) => {
      const roll = rngConsent.nextInt(1, 10_000);
      const state =
        roll <= CONSENT_OPT_IN_SHARE
          ? ('opt_in' as const)
          : roll <= CONSENT_OPT_IN_SHARE + CONSENT_OPT_OUT_SHARE
            ? ('opt_out' as const)
            : null;

      if (state === null) return [];

      return [
        {
          customer_id: customerId,
          channel: 'sms' as const,
          state,
          source: state === 'opt_in' ? 'checkout_optin' : 'sms_stop_reply',
          recorded_at: SIM_EPOCH,
        },
      ];
    });

    for (const part of chunk(consentRows, INSERT_CHUNK)) {
      await tx.insertInto('consent_event').values(part).execute();
    }

    const txnIds = txns.map((_, index) => deterministicId('txn', seed, arm, world, index));

    for (const part of chunk(
      txns.map((planned, index) => {
        const customerId = customerIds[planned.customerIndex];
        if (customerId === undefined) throw new Error('unreachable: customer index out of range');
        return {
          id: txnIds[index],
          // World-independent, so the same transaction draws the same outcome in every
          // arm and every world. Identity and the random stream are different concerns.
          logical_ref: String(index),
          batch_id: batch.id,
          customer_id: customerId,
          amount_paise: String(planned.amountPaise),
          margin_bps: planned.marginBps,
          rail: planned.rail,
          is_recurring: planned.isRecurring,
          // The schema refuses a recurring transaction with no mandate reference, so the
          // two facts are always generated together.
          mandate_ref: planned.isRecurring ? `UMN${seed}${planned.customerIndex}` : null,
          failed_at: planned.failedAt,
        };
      }),
      INSERT_CHUNK,
    )) {
      await tx.insertInto('txn').values(part).execute();
    }

    for (const part of chunk(
      txns.map((planned, index) => {
        const txnId = txnIds[index];
        if (txnId === undefined) throw new Error('unreachable: txn index out of range');
        return {
          txn_id: txnId,
          gateway_code: planned.gatewayCode,
          gateway_description: planned.description,
          // The true cause is recorded here and nowhere the policy engine can reach it.
          // The eval harness reads it to score classification; no decision path selects it.
          raw: JSON.stringify({
            simulator: { true_reason_code: planned.trueCode, rendering: planned.rendering },
          }),
        };
      }),
      INSERT_CHUNK,
    )) {
      await tx.insertInto('failure_event').values(part).execute();
    }

    const byReasonCode: Record<string, number> = {};
    for (const planned of txns) {
      byReasonCode[planned.trueCode] = (byReasonCode[planned.trueCode] ?? 0) + 1;
    }

    return {
      batchId: batch.id,
      seed,
      arm,
      world,
      count,
      customers: customerIds.length,
      novelStrings: txns.filter((t) => t.rendering === 'novel').length,
      injectionStrings: txns.filter((t) => t.rendering === 'injection').length,
      byReasonCode,
    };
  });
}
