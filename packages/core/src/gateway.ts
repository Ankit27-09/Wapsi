import type { IdempotencyKey } from './ids.js';
import type { Paise } from './money.js';
import type { Rail } from './taxonomy.js';

/**
 * THE PAYMENT GATEWAY PORT
 *
 * An interface, deliberately placed in the one package that depends on nothing.
 *
 * The engine calls it; the simulator implements it; in production a live processor client
 * implements it instead. Dependency inversion needs the contract to live somewhere both
 * sides can see, and every other candidate breaks something:
 *
 *   - In `@rc/engine`: the simulator would have to import the engine, which transitively
 *     imports `@rc/policy`. That is a path from the simulator to the policy engine —
 *     exactly what the Chinese wall forbids — and a rule matching only DIRECT imports
 *     would not have caught it. (It nearly didn't. The reachability rule in
 *     `.dependency-cruiser.cjs` exists because of this.)
 *   - In `@rc/policy`: worse, and for the obvious reason.
 *
 * So it sits here, using nothing but the vocabulary already defined alongside it.
 *
 * `lookup` is the half most implementations omit, and it is the half that makes
 * crash-resume correct rather than hopeful.
 */
export interface Gateway {
  /**
   * Attempt a payment.
   *
   * The idempotency key goes TO the gateway, not merely into our own records. A real
   * gateway deduplicates on it, so a dispatch re-sent after a crash returns the original
   * outcome instead of charging the customer a second time.
   */
  attempt(request: GatewayRequest): Promise<GatewayOutcome>;

  /**
   * Ask what happened to a key the gateway may or may not have seen.
   *
   * Called during reconciliation, when a decision is `pending` and the process cannot know
   * whether the previous dispatch landed. `null` means the gateway has no record, so the
   * dispatch never arrived and may safely be re-sent under the same key.
   */
  lookup(key: IdempotencyKey): Promise<GatewayOutcome | null>;
}

export interface GatewayRequest {
  readonly idempotencyKey: IdempotencyKey;
  readonly amount: Paise;
  readonly rail: Rail;
  /**
   * Routing context the gateway needs and the engine does not interpret.
   *
   * Opaque by design: the engine assembles it and passes it through untouched. In the eval
   * harness it carries what the simulator conditions its ground truth on; in production it
   * would carry whatever the processor's API wants. Keeping it opaque is how the one place
   * the two halves must physically meet stays free of shared assumptions — but the
   * implementer must VALIDATE it, because a mismatch here surfaces as a silently wrong
   * outcome rather than an error.
   */
  readonly context: Readonly<Record<string, string>>;
}

export interface GatewayOutcome {
  readonly succeeded: boolean;
  /** The gateway's own code for what happened. Free text, possibly useless. */
  readonly code: string | null;
  /** What the gateway charged, successful or not. The reason net value differs from recovery rate. */
  readonly fee: Paise;
  /** Amount recovered. Zero unless `succeeded`. */
  readonly recovered: Paise;
}
