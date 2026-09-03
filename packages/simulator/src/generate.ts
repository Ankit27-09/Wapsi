import {
  bps,
  causeIsValidFor,
  deterministicId,
  type Rail,
  type ReasonCode,
  type RiskClass,
} from '@rc/core';
import { ensureReasonCodesSeeded, type Arm, type Db } from '@rc/db';
import { deriveRng, type Rng } from './rng.js';
import { FAILURE_STRINGS, INJECTION_STRINGS, NOVEL_STRINGS } from './strings.js';
import { ensureTemplatesSeeded } from './templates.js';
import { planAuthStream } from './authstream.js';
import { loadTruthModel, type Outage } from './truth.js';

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

/**
 * Card BIN buckets, matching the vocabulary the authorisation stream uses.
 *
 * Assigned by customer index rather than drawn, so one customer keeps one card across all
 * their failures. A BIN redrawn per transaction would make a BIN-level cohort meaningless —
 * it would be a random partition of the population rather than a group of instruments that
 * share an issuing range and therefore share a fault.
 */
const CARD_BINS = ['BIN_4213', 'BIN_5521', 'BIN_6073', 'BIN_4074'] as const;

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
  { minPaise: 9_900, maxPaise: 99_900, marginBps: 2600 },
  { minPaise: 100_000, maxPaise: 999_900, marginBps: 1900 },
  { minPaise: 1_000_000, maxPaise: 9_999_900, marginBps: 1200 },
  { minPaise: 10_000_000, maxPaise: 50_000_000, marginBps: 800 },
] as const;

/**
 * Which amount tiers each risk class draws from.
 *
 * Not one shared distribution, because the classes genuinely differ in size and the
 * difference is what the expected-value gate exists to act on. A B2B invoice is two orders
 * of magnitude larger than a subscription cycle and carries a third of the margin, so a
 * single blended tier mix would hide the trade-off the whole system is built around: an
 * eighteen-paise nudge is trivially worth sending on a ₹4 lakh receivable and genuinely
 * marginal on a ₹499 abandoned cart.
 *
 * Weights are per tier, in the order above, and need not sum to anything.
 */
const AMOUNT_TIER_WEIGHTS: Readonly<Record<RiskClass, readonly [number, number, number, number]>> =
  {
    payment_failure: [45, 35, 15, 5],
    // Subscription cycles are small and recur. The value comes from the horizon, not the
    // ticket, which is exactly the case a per-transaction gate gets wrong without
    // `lifetime_cycles`.
    subscription_failure: [70, 28, 2, 0],
    mandate_lapsed: [65, 32, 3, 0],
    // Carts skew small, with a tail of considered purchases.
    checkout_abandonment: [55, 33, 11, 1],
    // B2B invoices. Low margin, large amounts, and the class where a single well-timed
    // message recovers more rupees than anything else in the system.
    receivable_overdue: [2, 18, 50, 30],
  };

/**
 * Risk class mix.
 *
 * Payment failures remain the plurality because that is what a payment gateway sees most of,
 * but the other four are weighted heavily enough to be measured rather than merely present.
 * A batch with three abandoned checkouts in it would let a checkout strategy look however
 * the noise happened to fall.
 */
const RISK_CLASS_MIX: readonly { readonly item: RiskClass; readonly weight: number }[] = [
  { item: 'payment_failure', weight: 38 },
  { item: 'subscription_failure', weight: 19 },
  { item: 'checkout_abandonment', weight: 20 },
  { item: 'receivable_overdue', weight: 16 },
  { item: 'mandate_lapsed', weight: 7 },
];

/**
 * Cause mix WITHIN each risk class.
 *
 * Nested rather than flat, and that is the structural point: a cause is only meaningful
 * inside a class. An invoice cannot decline for insufficient funds and a cart cannot have an
 * expired card, so a single flat mix would generate transactions that cannot exist — and any
 * strategy evaluated against them would be evaluated against fiction.
 *
 * `RISK_CLASS_META` is the authority on which pairs are legal, and `causeIsValidFor` asserts
 * every entry below against it at generation time.
 *
 * `do_not_honour` is weighted heavily inside the payment classes on purpose: it is the most
 * common card decline in the world, and a batch that under-represents it would make recovery
 * look far more tractable than it is.
 */
const CAUSE_MIX: Readonly<
  Record<RiskClass, readonly { readonly item: ReasonCode; readonly weight: number }[]>
> = {
  payment_failure: [
    { item: 'insufficient_funds', weight: 30 },
    { item: 'do_not_honour', weight: 26 },
    { item: 'threeds_timeout', weight: 19 },
    { item: 'issuer_down', weight: 9 },
    { item: 'card_expired', weight: 8 },
    { item: 'network_timeout', weight: 5 },
    { item: 'suspected_fraud_block', weight: 3 },
  ],
  subscription_failure: [
    { item: 'insufficient_funds', weight: 44 },
    { item: 'do_not_honour', weight: 22 },
    { item: 'card_expired', weight: 18 },
    { item: 'issuer_down', weight: 10 },
    { item: 'network_timeout', weight: 6 },
  ],
  mandate_lapsed: [{ item: 'mandate_expired', weight: 100 }],
  checkout_abandonment: [
    // Monotonically falling with funnel depth, which is what a real funnel does — and the
    // reason the four stages are separate causes is that their recovery rates differ by more
    // than 5x, so the shape of this mix matters as much as its levels.
    { item: 'abandoned_at_cart', weight: 42 },
    { item: 'abandoned_at_address', weight: 24 },
    { item: 'abandoned_at_payment', weight: 20 },
    { item: 'abandoned_at_otp', weight: 14 },
  ],
  receivable_overdue: [
    { item: 'payment_run_cycle', weight: 30 },
    { item: 'awaiting_approval', weight: 26 },
    { item: 'no_response', weight: 24 },
    { item: 'promised_not_paid', weight: 12 },
    { item: 'disputed_line_item', weight: 8 },
  ],
};

/**
 * How overdue an invoice is, by cause, in days.
 *
 * Cause and age are not independent, and pretending they were would break the one thing this
 * class turns on. An invoice sitting behind a monthly payment run is a few weeks late by
 * definition; one that has had no reply for four months is a different problem with a
 * different answer, and generating both from one distribution would make the age column
 * uninformative.
 */
const DAYS_OVERDUE_BY_CAUSE: Readonly<Record<string, readonly [number, number]>> = {
  payment_run_cycle: [4, 34],
  awaiting_approval: [7, 45],
  no_response: [30, 140],
  promised_not_paid: [21, 90],
  disputed_line_item: [14, 120],
};

/** Remaining billing cycles on a failed subscription. */
const LIFETIME_CYCLES_RANGE: readonly [number, number] = [2, 24];

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
 * Share of customers registered on the NCPR / DND list.
 *
 * Real and large. Modelling it as a rounding error would make the voice channel look far
 * more available than it is, and the whole reason voice is worth building carefully is that
 * it is expensive AND frequently unlawful — a combination that only an expected-value gate
 * with a hard compliance bound in front of it handles correctly.
 */
const NCPR_SHARE = bps(2500);

/** Share of customers who have opted in to receiving CALLS, which is far fewer than SMS. */
const VOICE_OPT_IN_SHARE = bps(4500);

/**
 * Share of silent receivables where the buyer has made a promise that is still open.
 *
 * Exists so the suppression path is measured rather than merely implemented: without an open
 * promise in the population, `promise_open` never fires and the claim that the system stops
 * chasing customers who have committed is untested.
 */
const OPEN_PROMISE_SHARE = bps(2500);

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
  readonly byRiskClass: Readonly<Record<string, number>>;
  readonly promises: number;
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
  readonly riskClass: RiskClass;
  /** Non-null exactly for `subscription_failure`. */
  readonly lifetimeCycles: number | null;
  /** Non-null exactly for `receivable_overdue`. */
  readonly daysOverdue: number | null;
  /**
   * A promise-to-pay, when the buyer has made one.
   *
   * `open` suppresses the ladder until its date; `broken` is what `promised_not_paid` means.
   * Both are generated because both are needed to demonstrate the mechanism — an
   * implementation with no open promise in its test population has not shown that it stops.
   */
  readonly promise: {
    readonly promisedFor: Date;
    readonly status: 'open' | 'broken';
    readonly obtainedVia: 'sms_reply' | 'voice_call' | 'payment_page' | 'agent_note';
  } | null;
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

    // Checkout abandonment and overdue receivables never reached a rail — nothing was ever
    // presented for authorisation. The column still needs a value, and the rail a customer
    // *would* have used is the useful one to record: it is what a recovery link would offer
    // them, and what the fee model would price if they took it.
    case 'abandoned_at_cart':
    case 'abandoned_at_address':
    case 'abandoned_at_payment':
    case 'abandoned_at_otp':
    case 'awaiting_approval':
    case 'disputed_line_item':
    case 'payment_run_cycle':
    case 'no_response':
    case 'promised_not_paid':
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
/**
 * One synthetic customer, before they touch the database.
 *
 * MOVED HERE FROM `generateBatch`, and the move is a correctness fix rather than tidying.
 * Consent, language and the NCPR flag used to be drawn inside the persistence function, so
 * the in-memory sweep had no access to them — it therefore gave every customer consent and a
 * universal template, and measured a system in which nobody had opted out.
 *
 * That made the sensitivity analysis a confident statement about the robustness of a
 * different, more permissive system than the one that ships. The whole point of the sweep is
 * that it replays THIS system, so the population has to be one population.
 */
export interface PlannedCustomer {
  readonly issuerId: string;
  readonly language: 'en' | 'hi_latn';
  /** Null means the customer never expressed a preference — which is not consent. */
  readonly smsConsent: 'opt_in' | 'opt_out' | null;
  readonly voiceOptIn: boolean;
  readonly onNcprRegistry: boolean;
}

export function planTxns(seed: number, count: number): {
  readonly txns: readonly PlannedTxn[];
  readonly customers: readonly PlannedCustomer[];
  /** Issuer ids alone, kept for the many call sites that only need those. */
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
  // Its own stream, so adding risk classes did not reshuffle every amount, cause and string
  // already generated — the property that lets one change be evaluated in isolation.
  const rngClasses = deriveRng(seed, 'risk_classes');
  const rngPromises = deriveRng(seed, 'promises');

  const truth = loadTruthModel();

  const customerCount = Math.max(1, Math.ceil(count / FAILURES_PER_CUSTOMER));
  const customerIssuers = Array.from(
    { length: customerCount },
    () => truth.pickIssuer(rngPopulation).id,
  );

  // Independent streams, drawn in a fixed order, so `generateBatch` and the sweep produce
  // the identical population — and so adding one of these later cannot reshuffle the others.
  const rngLanguage = deriveRng(seed, 'language');
  const rngConsent = deriveRng(seed, 'consent');
  const rngRegistry = deriveRng(seed, 'ncpr');

  const customers: PlannedCustomer[] = customerIssuers.map((issuerId) => {
    const language = rngLanguage.chance(HINGLISH_SHARE) ? ('hi_latn' as const) : ('en' as const);

    // One draw, three outcomes, so the shares are exact rather than approximately
    // independent. Customers with no row at all are the interesting population: `unknown`
    // is not `opt_in`, so they are unmessageable, and seeding a book where everyone had
    // consented would make the consent bound untestable and the compliance layer decorative.
    const roll = rngConsent.nextInt(1, 10_000);
    const smsConsent =
      roll <= CONSENT_OPT_IN_SHARE
        ? ('opt_in' as const)
        : roll <= CONSENT_OPT_IN_SHARE + CONSENT_OPT_OUT_SHARE
          ? ('opt_out' as const)
          : null;

    // Drawn separately and materially rarer than SMS consent, which is true of every
    // merchant's book: people accept transactional messages and decline calls.
    const voiceOptIn = rngConsent.chance(VOICE_OPT_IN_SHARE);

    return {
      issuerId,
      language,
      smsConsent,
      voiceOptIn,
      onNcprRegistry: rngRegistry.chance(NCPR_SHARE),
    };
  });

  const txns: PlannedTxn[] = [];

  for (let i = 0; i < count; i += 1) {
    // CLASS FIRST, THEN CAUSE. The class determines which causes are even possible, so
    // drawing the cause first and then trying to find a class for it would produce
    // transactions that cannot exist — an invoice declining for insufficient funds.
    const riskClass = rngClasses.weighted(RISK_CLASS_MIX);

    const tierWeights = AMOUNT_TIER_WEIGHTS[riskClass];
    const tier = rngAmounts.weighted(
      AMOUNT_TIERS.map((t, index) => ({ item: t, weight: tierWeights[index] ?? 0 })),
    );
    const amountPaise = rngAmounts.nextInt(tier.minPaise, tier.maxPaise);

    const trueCode = rngCauses.weighted(CAUSE_MIX[riskClass]);
    if (!causeIsValidFor(riskClass, trueCode)) {
      // Unreachable while CAUSE_MIX matches RISK_CLASS_META, which is the point of checking:
      // the two are separate declarations, and a drift between them would otherwise surface
      // as a class silently receiving a cause whose interventions it does not permit.
      throw new Error(`Generated ${trueCode} for ${riskClass}, which cannot have that cause`);
    }

    const rail = railFor(trueCode, rngCauses);

    // RECURRENCE FOLLOWS ENTIRELY FROM THE CLASS, and used to be a 30% coin flip on top of
    // `payment_failure` as well. That draw had to go, because it created a category that was
    // neither one thing nor the other: a recurring transaction with a live mandate, whose
    // class said "one-off payment" and whose strategy therefore had no pre-debit notice step.
    // Every retry on those was refused with `pre_debit_notice` — correctly, since debiting a
    // mandate without notice is unlawful, and unrecoverably, since the policy for a one-off
    // never schedules one.
    //
    // The honest model is that a recurring card-on-file payment failing IS a subscription
    // failure. Making recurrence a property of the class rather than an independent draw
    // removes the contradiction instead of adding a special case to work around it.
    const isRecurring =
      riskClass === 'subscription_failure' || riskClass === 'mandate_lapsed';

    const lifetimeCycles =
      riskClass === 'subscription_failure'
        ? rngClasses.nextInt(LIFETIME_CYCLES_RANGE[0], LIFETIME_CYCLES_RANGE[1])
        : null;

    const overdueRange = DAYS_OVERDUE_BY_CAUSE[trueCode];
    const daysOverdue =
      riskClass === 'receivable_overdue' && overdueRange !== undefined
        ? rngClasses.nextInt(overdueRange[0], overdueRange[1])
        : null;

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
      riskClass,
      lifetimeCycles,
      daysOverdue,
      promise: planPromise(trueCode, failedAt, rngPromises),
      ...rendered,
    });
  }

  // ---- the cases an outage actually produces ------------------------------
  // Appended, on their own RNG stream, so nothing above is reshuffled.
  //
  // WHY THEY HAVE TO EXIST. The main population's failures are spread across seven days,
  // and an outage occupies ninety minutes of one of them. Drawn independently, essentially
  // none of the 300 recovery cases belongs to an affected cohort at an affected time — so
  // the detector found both episodes, correctly, and changed not one decision. A feature
  // that is wired up and never fires is worse than an absent one, because the wiring looks
  // like evidence.
  //
  // The fix is to model the real pipeline rather than to widen a threshold until something
  // happened: an outage causes a burst of failures, and those failures ARE recovery cases.
  txns.push(
    ...planOutageCases(seed, truth.outages, customers, {
      rngStrings: deriveRng(seed, 'outage_strings'),
      rngAmounts: deriveRng(seed, 'outage_amounts'),
    }),
  );

  return { txns, customers, customerIssuers };
}

/**
 * How many recovery cases each material outage contributes.
 *
 * Modest on purpose. The point is to make the detector's finding actionable on a measurable
 * slice of the book, not to make the headline depend on it — an outage cohort large enough
 * to move the total would be choosing the result rather than demonstrating the mechanism.
 */
const CASES_PER_OUTAGE = 14;

/**
 * The share of an outage's failures that carry its own cause.
 *
 * NOT ALL OF THEM, and that is the interesting part. A degraded cohort keeps failing for its
 * ordinary reasons too — people are still short of funds while the issuer's host is down —
 * so the dominant code tells you WHY the cohort is bad without claiming every decline in it
 * has that cause.
 *
 * It also makes the fraud-rule bound reachable. `suspected_fraud_block` is a structural zero,
 * so a transaction carrying it is refused as `terminal` whatever the population says. The
 * transactions a fraud-rule signal genuinely protects are the ordinary ones in the same
 * cohort: an `insufficient_funds` retry on a card whose issuer has just tightened its risk
 * engine is going to be declined too, and only the population knows that.
 */
const OUTAGE_DOMINANT_SHARE = 7000;

/** Ordinary causes that continue during an outage, all legal for `payment_failure`. */
const OUTAGE_BACKGROUND_CAUSES: readonly {
  readonly item: ReasonCode;
  readonly weight: number;
}[] = [
  { item: 'insufficient_funds', weight: 46 },
  { item: 'do_not_honour', weight: 34 },
  { item: 'threeds_timeout', weight: 20 },
];

function planOutageCases(
  seed: number,
  outages: readonly Outage[],
  customers: readonly PlannedCustomer[],
  rngs: { readonly rngStrings: Rng; readonly rngAmounts: Rng },
): readonly PlannedTxn[] {
  const rng = deriveRng(seed, 'outage_cases');
  const out: PlannedTxn[] = [];

  for (const outage of outages) {
    if (!outage.material) continue;

    // Only customers on the affected issuer can be affected by it. A case attributed to the
    // wrong issuer would be invisible to the detector's cohort filter and would silently
    // reduce the number of transactions the signal reaches.
    const eligible = customers
      .map((customer, index) => ({ customer, index }))
      .filter((entry) => entry.customer.issuerId === outage.issuer_id);

    if (eligible.length === 0) continue;

    for (let i = 0; i < CASES_PER_OUTAGE; i += 1) {
      const chosen = eligible[i % eligible.length];
      if (chosen === undefined) continue;

      const trueCode = rng.chance(bps(OUTAGE_DOMINANT_SHARE))
        ? outage.dominant_code
        : rng.weighted(OUTAGE_BACKGROUND_CAUSES);

      // Every outage cause must be legal for the class it is filed under, checked rather
      // than assumed — the yaml is hand-edited and a `dominant_code` of `abandoned_at_cart`
      // would otherwise produce a transaction that cannot exist.
      if (!causeIsValidFor('payment_failure', trueCode)) {
        throw new Error(
          `Outage on ${outage.issuer_id} names ${trueCode}, which is not a legal cause for ` +
            'payment_failure — the class outage-derived cases are filed under',
        );
      }

      // Inside the window, so the decision clock lands where the signal is in force.
      const minute =
        outage.start_offset_minutes + rng.nextInt(0, Math.max(1, outage.duration_minutes - 1));
      const failedAt = new Date(SIM_EPOCH.getTime() + minute * 60_000);

      const tierWeights = AMOUNT_TIER_WEIGHTS.payment_failure;
      const tier = rngs.rngAmounts.weighted(
        AMOUNT_TIERS.map((t, index) => ({ item: t, weight: tierWeights[index] ?? 0 })),
      );

      out.push({
        customerIndex: chosen.index,
        amountPaise: rngs.rngAmounts.nextInt(tier.minPaise, tier.maxPaise),
        marginBps: tier.marginBps,
        rail: outage.rail,
        isRecurring: false,
        trueCode,
        failedAt,
        riskClass: 'payment_failure',
        lifetimeCycles: null,
        daysOverdue: null,
        promise: null,
        ...renderDescription(trueCode, rngs.rngStrings),
      });
    }
  }

  return out;
}

/**
 * Whether this transaction carries a promise-to-pay, and of what kind.
 *
 * Two distinct populations, because they exercise opposite behaviours:
 *
 *   BROKEN, on every `promised_not_paid` invoice. That code means precisely this, so
 *   generating the code without the promise would leave the follow-up scheduled against a
 *   date that does not exist.
 *
 *   OPEN, on a quarter of silent invoices. The suppression path — the system's claim that it
 *   stops chasing a buyer who has committed to a date — is only a claim until a population
 *   with open promises in it fires `promise_open`.
 */
function planPromise(
  code: ReasonCode,
  failedAt: Date,
  rng: Rng,
): PlannedTxn['promise'] {
  if (code === 'promised_not_paid') {
    // One to three days after the failure, so the `promise_followup` step lands after the
    // date rather than before it.
    const days = rng.nextInt(1, 3);
    return {
      promisedFor: new Date(failedAt.getTime() + days * 86_400_000),
      status: 'broken',
      obtainedVia: rng.chance(bps(5000)) ? 'sms_reply' : 'voice_call',
    };
  }

  if (code === 'no_response' && rng.chance(OPEN_PROMISE_SHARE)) {
    // Comfortably beyond the longest timing bucket (120h), so the promise is still open at
    // every point the ladder would otherwise have acted.
    const days = rng.nextInt(8, 14);
    return {
      promisedFor: new Date(failedAt.getTime() + days * 86_400_000),
      status: 'open',
      obtainedVia: rng.chance(bps(4000)) ? 'payment_page' : 'agent_note',
    };
  }

  return null;
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

  const { txns, customers, customerIssuers } = planTxns(seed, count);

  // Reference data the policy depends on. Idempotent, and seeded outside the batch
  // transaction because registered templates are shared across every world rather than
  // owned by one of them.
  // Reference data first: auth_attempt.gateway_code and degradation_signal.dominant_code
  // both live in the taxonomy vocabulary, and the latter holds a foreign key to it.
  await ensureReasonCodesSeeded(db);
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

    // Written FROM the planned population rather than drawn again here. Two draws of the
    // same fact are two facts that can disagree, and the sweep replays the planned one — so
    // a second derivation would let the robustness check quietly measure a different book of
    // customers from the one the persisted run uses.
    for (const part of chunk(
      customers.map((customer, index) => ({
        id: customerIds[index],
        external_ref: `${seed}:${arm}:${world}:${index}:${customer.issuerId}`,
        display_name: `Synthetic Customer ${index + 1}`,
        preferred_language: customer.language,
        on_ncpr_registry: customer.onNcprRegistry,
      })),
      INSERT_CHUNK,
    )) {
      await tx.insertInto('customer').values(part).execute();
    }

    // Consent, as an append-only ledger. Customers with no row are `unknown`, which is not
    // `opt_in` — they are unmessageable, and that population needs to exist or the consent
    // bound is never exercised.
    //
    // Voice is a separate row and materially rarer, which together with the NCPR share makes
    // calling unavailable for most of the population. That is the correct answer, and the
    // reason an escalation ladder has to treat a call as a scarce resource rather than as a
    // louder SMS.
    const consentRows = customers.flatMap((customer, index) => {
      const customerId = customerIds[index];
      if (customerId === undefined) throw new Error('unreachable: customer index out of range');

      const rows = [];

      if (customer.smsConsent !== null) {
        rows.push({
          customer_id: customerId,
          channel: 'sms' as const,
          state: customer.smsConsent,
          source: customer.smsConsent === 'opt_in' ? 'checkout_optin' : 'sms_stop_reply',
          recorded_at: SIM_EPOCH,
        });
      }

      if (customer.voiceOptIn) {
        rows.push({
          customer_id: customerId,
          channel: 'voice' as const,
          state: 'opt_in' as const,
          source: 'ivr_confirmation',
          recorded_at: SIM_EPOCH,
        });
      }

      return rows;
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
          //
          // A LAPSED mandate is the exception, and it is not a technicality: the whole
          // meaning of `mandate_lapsed` is that no live authorisation exists. Writing a
          // reference for one would make `mandateBacked` true, and the engine would then
          // require a pre-debit notice for a debit that can never happen.
          mandate_ref:
            planned.isRecurring && planned.riskClass !== 'mandate_lapsed'
              ? `UMN${seed}${planned.customerIndex}`
              : null,
          failed_at: planned.failedAt,
          risk_class: planned.riskClass,
          lifetime_cycles: planned.lifetimeCycles,
          days_overdue: planned.daysOverdue,
          // The cohort keys. Previously reachable only by parsing `customer.external_ref`,
          // which is fine for display and useless for a GROUP BY — see `014_degradation.sql`.
          issuer_id: customers[planned.customerIndex]?.issuerId ?? null,
          // Only card traffic has a BIN. Deriving it from the customer index rather than
          // drawing it keeps a customer on one card across their failures, which is what
          // makes a BIN-level cohort meaningful at all.
          bin_bucket:
            planned.rail === 'card'
              ? (CARD_BINS[planned.customerIndex % CARD_BINS.length] ?? null)
              : null,
        };
      }),
      INSERT_CHUNK,
    )) {
      await tx.insertInto('txn').values(part).execute();
    }

    // Promises to pay. Written after the transactions they reference, and only for the
    // transactions that have one — a promise on a payment failure would be meaningless,
    // since the whole construct belongs to a conversation with a buyer.
    const promiseRows = txns.flatMap((planned, index) => {
      if (planned.promise === null) return [];
      const txnId = txnIds[index];
      const customerId = customerIds[planned.customerIndex];
      if (txnId === undefined || customerId === undefined) {
        throw new Error('unreachable: index out of range while writing promises');
      }
      return [
        {
          customer_id: customerId,
          txn_id: txnId,
          promised_paise: String(planned.amountPaise),
          promised_for: planned.promise.promisedFor,
          obtained_via: planned.promise.obtainedVia,
          // Obtained at the moment the invoice went overdue, which is when the chaser would
          // first have made contact.
          obtained_at: planned.failedAt,
          status: planned.promise.status,
          // A resolved promise must carry a resolution time; the CHECK enforces it, so a
          // broken one is dated the day after it was due.
          resolved_at:
            planned.promise.status === 'open'
              ? null
              : new Date(planned.promise.promisedFor.getTime() + 86_400_000),
        },
      ];
    });

    for (const part of chunk(promiseRows, INSERT_CHUNK)) {
      await tx.insertInto('promise').values(part).execute();
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

    // ---- the authorisation stream ------------------------------------------
    // The input to detection, and a different dataset from the recovery cases: it carries
    // successes, which are the denominator no rate can be computed without.
    //
    // Truth is loaded a second time here rather than threaded down from `planTxns`.
    // `loadTruthModel` re-reads and re-parses the file, so this is one extra parse of a 20KB
    // YAML per batch — measurable, and worth it: the alternative is returning the truth
    // model out of the planner so the writer can reach it, which puts a ground-truth handle
    // in a public return type one import away from code that must never see it. Cheap
    // duplication beats a widened blast radius on the wall.
    const streamTruth = loadTruthModel();
    const stream = planAuthStream(seed, SIM_EPOCH, streamTruth.issuers, streamTruth.outages);

    for (const part of chunk(
      stream.map((attempt) => ({
        batch_id: batch.id,
        issuer_id: attempt.issuerId,
        rail: attempt.rail,
        bin_bucket: attempt.binBucket,
        succeeded: attempt.succeeded,
        amount_paise: String(attempt.amountPaise),
        gateway_code: attempt.reasonCode,
        occurred_at: attempt.occurredAt,
        // Deliberately null. These are the merchant's own traffic, not the seeded recovery
        // cases — linking them would double-count the population and put collected payments
        // into the recovery book. The join that matters goes the other way: a detected
        // cohort is matched to transactions by issuer, rail and time.
        txn_id: null,
      })),
      INSERT_CHUNK,
    )) {
      await tx.insertInto('auth_attempt').values(part).execute();
    }

    const byReasonCode: Record<string, number> = {};
    const byRiskClass: Record<string, number> = {};
    for (const planned of txns) {
      byReasonCode[planned.trueCode] = (byReasonCode[planned.trueCode] ?? 0) + 1;
      byRiskClass[planned.riskClass] = (byRiskClass[planned.riskClass] ?? 0) + 1;
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
      byRiskClass,
      promises: promiseRows.length,
    };
  });
}
