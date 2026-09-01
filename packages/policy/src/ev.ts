import { ZERO, add, gte, mulBps, sub, type Bps, type Paise } from '@rc/core';

/**
 * THE EXPECTED-VALUE GATE
 *
 * Every candidate action passes through here before anything happens. If the expected
 * value is below the policy floor, the action does not fire and the refusal is audited
 * with its arithmetic attached.
 *
 * Three things about this that are worth stating out loud, because they are what separate
 * it from a `maxAttempts` constant:
 *
 * 1. STOPPING BECOMES DERIVED, NOT CONFIGURED. An attempt sequence terminates when
 *    expected value crosses the floor. The schedule length remains as a hard safety
 *    ceiling, but on most transactions it is not the binding constraint — economics is.
 *
 * 2. IT MULTIPLIES BY CONTRIBUTION MARGIN, NOT GROSS AMOUNT. Recovering a rupee of
 *    revenue is not worth a rupee of effort; it is worth its margin. A ₹4 lakh B2B
 *    invoice at 8% margin and a ₹499 subscription at 26% are closer in value than their
 *    sizes suggest, and on a low-margin ticket a single ₹3.50 card retry can genuinely
 *    fail to justify itself.
 *
 * 3. REFUSALS ARE AUDITABLE EVENTS. Both verdicts carry the full arithmetic, so the
 *    system can be asked *why didn't you try?* and answers in rupees rather than in
 *    prose. That is the whole reason the decision table records refusals at all.
 *
 * Pure. No I/O, no clock, no database. Property-tested in `ev.test.ts`.
 */

export interface EvInput {
  /** The failed payment's gross amount. */
  readonly amount: Paise;
  /** Contribution margin in integer basis points. */
  readonly marginBps: Bps;
  /** Success probability from the PUBLISHED priors. Never from simulator truth. */
  readonly pBps: Bps;
  /** Gateway fee for the rail this attempt would use. */
  readonly gatewayFee: Paise;
  /** Messaging cost, or zero when this step contacts nobody. */
  readonly messageCost: Paise;
  /** Amortised model spend, so the LLM's cost lands in net value rather than outside it. */
  readonly llmCost: Paise;
  /** The policy's expected-value floor. */
  readonly floor: Paise;
}

/**
 * The four numbers snapshotted onto every decision row.
 *
 * Deliberately not five: the expected recovery (`value × p`) is derivable from `value`
 * and `pBps`, so storing it too would be a fifth number that can disagree with the other
 * four. `expected()` below recomputes it wherever it is needed for display.
 */
export interface EvArithmetic {
  readonly pBps: Bps;
  /** Contribution margin at stake if the attempt succeeds: `amount × marginBps`. */
  readonly value: Paise;
  /** Everything this attempt costs whether or not it works. */
  readonly cost: Paise;
  /** `value × pBps − cost`. Signed: a negative expected value is the point of the gate. */
  readonly net: Paise;
}

export type EvVerdict =
  | { readonly kind: 'pass'; readonly arithmetic: EvArithmetic }
  | {
      readonly kind: 'fail';
      readonly arithmetic: EvArithmetic;
      readonly floor: Paise;
      readonly detail: string;
    };

/** The expected recovery implied by an arithmetic snapshot. */
export function expected(arithmetic: EvArithmetic): Paise {
  return mulBps(arithmetic.value, arithmetic.pBps);
}

/**
 * Evaluate one candidate action.
 *
 * Integer arithmetic end to end — amount in paise, margin in basis points, probability in
 * basis points. There is no `number` in the computation, which is a stronger guarantee
 * than "we do not use floats for money": a float probability would reintroduce
 * floating-point into every expected value in the system through the back door.
 */
export function evGate(input: EvInput): EvVerdict {
  const value = mulBps(input.amount, input.marginBps);
  const cost = add(add(input.gatewayFee, input.messageCost), input.llmCost);
  const net = sub(mulBps(value, input.pBps), cost);

  const arithmetic: EvArithmetic = { pBps: input.pBps, value, cost, net };

  // A STRUCTURAL refusal, checked before the economics.
  //
  // An action that cannot succeed must never fire — even when it happens to be free and
  // the floor happens to be zero, where `net` would be exactly zero and clear the floor
  // on a technicality. Without this branch the only thing standing between the system and
  // a pointless attempt against a revoked mandate is a config value, and removing config
  // from that position is the entire reason this gate exists.
  //
  // Found by a property test, not by review: `p = 0, cost = 0, floor = 0` passed.
  if (input.pBps === 0) {
    return {
      kind: 'fail',
      arithmetic,
      floor: input.floor,
      detail: 'Success probability is zero — no attempt can recover this payment.',
    };
  }

  if (gte(net, input.floor)) return { kind: 'pass', arithmetic };

  return {
    kind: 'fail',
    arithmetic,
    floor: input.floor,
    detail: describeFailure(input, arithmetic),
  };
}

/**
 * Why this action was not worth taking, in words a human will read in the exception queue.
 *
 * Separating the diagnosis from the arithmetic matters: the numbers are what the system
 * acted on, and this is what an operator needs in order to disagree with it. A refusal
 * that says only "EV below floor" invites the reader to re-derive the reasoning by hand.
 */
function describeFailure(input: EvInput, arithmetic: EvArithmetic): string {
  if (arithmetic.net < ZERO) {
    return (
      `Expected recovery is smaller than the cost of trying: the attempt costs more ` +
      `than it is worth in expectation, so firing it would destroy value.`
    );
  }

  return (
    `Expected value is positive but below the policy floor: not enough upside to ` +
    `justify the fee and the customer contact.`
  );
}
