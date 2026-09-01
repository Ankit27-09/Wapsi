import {
  PaiseSchema,
  ReasonCodeSchema,
  ZERO,
  paise,
  type Gateway,
  type GatewayOutcome,
  type GatewayRequest,
  type IdempotencyKey,
  type Paise,
  type Rail,
} from '@rc/core';
import type { Db } from '@rc/db';
import { deriveRng } from './rng.js';
import { loadTruthModel, type TruthModel, type TruthTiming } from './truth.js';

/**
 * The seeded gateway.
 *
 * Implements the `Gateway` interface the engine declares, so the engine cannot tell it
 * apart from a live processor. Two properties matter more than anything else here.
 *
 * DETERMINISM INDEPENDENT OF CALL ORDER.
 *
 * The random draw for an attempt is derived from the attempt's OWN idempotency key, not
 * from a running generator. That makes the outcome a pure function of
 * (seed, key, truth, issuer) â€” so reordering the batch, running the arms in a different
 * sequence, or processing transactions concurrently all produce identical results. A
 * shared sequential generator would make the answer depend on scheduling, and "same seed,
 * same numbers" would quietly become "same seed, same numbers, same machine load".
 *
 * MEMORY THAT SURVIVES THE PROCESS.
 *
 * Records go to `sim_gateway_log`, not to a Map. Killing the worker must not erase the
 * gateway's knowledge of what it already charged, or the crash-resume demonstration would
 * appear to succeed while proving the opposite of its claim.
 */

/**
 * Nominal hours each timing bucket represents.
 *
 * The simulator's view of when a retry actually lands. Used by the eval runner to advance
 * simulated time, and by nothing in the policy â€” the policy reasons about buckets, the
 * world reasons about hours.
 */
export const TIMING_HOURS: Readonly<Record<TruthTiming, number>> = {
  immediate: 0.05,
  short_backoff: 0.25,
  medium_backoff: 3,
  next_day: 24,
  salary_window: 72,
  alt_rail: 0.1,
};

/**
 * The gateway's fee schedule.
 *
 * Deliberately identical to the policy's. Fees are CONTRACTUAL â€” a merchant knows what
 * its processor charges â€” so there is no honest reason to model the policy as uncertain
 * about them. Probabilities are a different matter entirely, and that asymmetry is the
 * whole point of the Chinese wall: the policy may be wrong about the world's behaviour,
 * never about its own invoice.
 */
const GATEWAY_FEE_PAISE: Readonly<Record<Rail, number>> = {
  card: 350,
  upi_collect: 80,
  upi_intent: 80,
  netbanking: 200,
  wallet: 150,
};

export interface SimulatorGatewayOptions {
  readonly db: Db;
  readonly seed: number;
  readonly batchId: string;
  /** Override for the hostile-world variants. Defaults to the shipped truth table. */
  readonly truth?: TruthModel;
}

/**
 * Build a gateway for one batch.
 *
 * Preloads the customer-to-issuer map, because issuer identity is unobservable to the
 * policy but is exactly what the truth model conditions on. Loading it once keeps the
 * per-attempt path free of queries, which matters when the eval runs five arms over a few
 * hundred transactions each.
 */
export async function createSimulatorGateway(
  options: SimulatorGatewayOptions,
): Promise<Gateway> {
  const { db, seed, batchId } = options;
  const truth = options.truth ?? loadTruthModel();

  // `external_ref` is `seed:arm:world:index:ISSUER`. The issuer lives there rather than in
  // its own column so that no query can casually join the policy to information it is not
  // supposed to have.
  const rows = await db
    .selectFrom('customer')
    .innerJoin('txn', 'txn.customer_id', 'customer.id')
    .select(['customer.id as id', 'customer.external_ref as external_ref'])
    .where('txn.batch_id', '=', batchId)
    .distinct()
    .execute();

  const issuerByCustomer = new Map<string, string>();
  for (const row of rows) {
    const issuer = row.external_ref.split(':').at(-1);
    if (issuer === undefined || issuer === '') {
      throw new Error(`Customer ${row.id} has no issuer encoded in external_ref`);
    }
    issuerByCustomer.set(row.id, issuer);
  }

  const readLog = async (key: IdempotencyKey): Promise<GatewayOutcome | null> => {
    const row = await db
      .selectFrom('sim_gateway_log')
      .select(['succeeded', 'gateway_code', 'fee_paise', 'recovered_paise'])
      .where('idempotency_key', '=', key)
      .executeTakeFirst();

    if (row === undefined) return null;

    return {
      succeeded: row.succeeded,
      code: row.gateway_code,
      fee: PaiseSchema.parse(row.fee_paise),
      recovered: PaiseSchema.parse(row.recovered_paise),
    };
  };

  return {
    async attempt(request: GatewayRequest): Promise<GatewayOutcome> {
      // Deduplicate first, exactly as a real gateway does. This is what makes a re-sent
      // dispatch after a crash safe rather than a second charge.
      const existing = await readLog(request.idempotencyKey);
      if (existing !== null) return existing;

      const outcome = decide(request, { seed, truth, issuerByCustomer });

      await db
        .insertInto('sim_gateway_log')
        .values({
          idempotency_key: request.idempotencyKey,
          succeeded: outcome.succeeded,
          gateway_code: outcome.code,
          fee_paise: outcome.fee.toString(),
          recovered_paise: outcome.recovered.toString(),
          batch_id: batchId,
        })
        .execute();

      return outcome;
    },

    lookup: readLog,
  };
}

function decide(
  request: GatewayRequest,
  deps: {
    readonly seed: number;
    readonly truth: TruthModel;
    readonly issuerByCustomer: ReadonlyMap<string, string>;
  },
): GatewayOutcome {
  const context = parseContext(request.context);
  const issuer = deps.issuerByCustomer.get(context.customerId);
  if (issuer === undefined) {
    throw new Error(`No issuer known for customer ${context.customerId}`);
  }

  const fee = feeFor(request.rail);

  // COMMON RANDOM NUMBERS, keyed on the transaction's world-independent position rather
  // than on its primary key.
  //
  // Keying on the idempotency key (which hashes the transaction id, which encodes the arm
  // and world) meant each arm faced a DIFFERENT set of coin flips — so part of any measured
  // gap between two strategies was luck rather than strategy. Every arm now meets the same
  // sequence of successes and failures, and a difference between them is attributable to
  // the difference between them.
  //
  // Call order still cannot change the answer: the key is a pure function of the attempt.
  const rng = deriveRng(
    deps.seed,
    `${context.logicalRef}:${context.attemptNo}:${context.timing}`,
  );
  const succeeded = deps.truth.attemptSucceeds(
    rng,
    context.reasonCode,
    context.attemptNo,
    context.timing,
    issuer,
  );

  return {
    succeeded,
    // A real gateway returns a code on failure and little on success. Mirrored here so the
    // classifier's input on a retry looks like the input on the original failure.
    code: succeeded ? 'CAPTURED' : `DECLINED_${context.reasonCode.toUpperCase()}`,
    // The fee is charged either way. That is the entire reason net value differs from
    // recovery rate, and the reason a naive retry-everything arm bleeds.
    fee,
    recovered: succeeded ? request.amount : ZERO,
  };
}

function feeFor(rail: Rail): Paise {
  const fee = GATEWAY_FEE_PAISE[rail];
  return paise(BigInt(fee));
}

interface ParsedContext {
  readonly customerId: string;
  /** World-independent position, the basis of the common random numbers. */
  readonly logicalRef: string;
  readonly reasonCode: Parameters<TruthModel['successProbability']>[0];
  readonly attemptNo: number;
  readonly timing: TruthTiming;
}

/**
 * Read the routing context the engine passed through.
 *
 * Validated rather than trusted. The engine treats this map as opaque and never inspects
 * it, so a mismatch between what it sends and what the gateway expects would otherwise
 * surface as a silently wrong probability â€” the worst possible failure mode here, because
 * every reported figure would still look plausible.
 */
function parseContext(context: Readonly<Record<string, string>>): ParsedContext {
  const customerId = context['customer_id'];
  const logicalRef = context['logical_ref'];
  const reasonCodeRaw = context['reason_code'];
  const attemptRaw = context['attempt_no'];
  const timingRaw = context['timing'];

  if (customerId === undefined || reasonCodeRaw === undefined) {
    throw new Error('Gateway context is missing customer_id or reason_code');
  }
  if (logicalRef === undefined) {
    throw new Error(
      'Gateway context is missing logical_ref; without it the outcome draw would key on ' +
        'world-scoped identity and every arm would face different coin flips',
    );
  }
  if (attemptRaw === undefined || timingRaw === undefined) {
    throw new Error(
      'Gateway context is missing attempt_no or timing; the simulator cannot price an ' +
        'attempt without knowing which attempt it is and when it lands',
    );
  }

  const timing = timingRaw as TruthTiming;
  if (!(timing in TIMING_HOURS)) {
    throw new Error(`Unknown timing "${timingRaw}" in gateway context`);
  }

  const attemptNo = Number.parseInt(attemptRaw, 10);
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new Error(`Invalid attempt_no "${attemptRaw}" in gateway context`);
  }

  return {
    customerId,
    logicalRef,
    reasonCode: ReasonCodeSchema.parse(reasonCodeRaw),
    attemptNo,
    timing,
  };
}
