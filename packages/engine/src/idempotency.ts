import { createHash } from 'node:crypto';
import { idempotencyKey, type IdempotencyKey, type TxnId } from '@rc/core';

/**
 * Derive an attempt's idempotency key.
 *
 * `sha256(txnId | attemptNo | policyVersion)` — a pure function of the decision that
 * produced it, never a random value. That distinction is the whole mechanism:
 *
 *   A worker crashes after dispatching to the gateway but before recording the outcome.
 *   On restart it recomputes this key from the same three facts, gets the same string,
 *   and the unique index on `decision.idempotency_key` refuses the duplicate insert. With
 *   a random key the second dispatch would look like a new attempt and the customer would
 *   be charged twice.
 *
 * `policyVersion` is in the hash deliberately. An attempt authorised under policy v3 is
 * not the same authorisation as one under v4, even for the same transaction and attempt
 * number — the bounds, timings and floor may all differ. Excluding it would let a policy
 * change silently collide with history.
 */
export function deriveIdempotencyKey(
  txnId: TxnId,
  attemptNo: number,
  policyVersion: number,
): IdempotencyKey {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new RangeError(`attemptNo must be a positive integer, got ${attemptNo}`);
  }
  if (!Number.isInteger(policyVersion) || policyVersion < 1) {
    throw new RangeError(`policyVersion must be a positive integer, got ${policyVersion}`);
  }

  // A delimiter that cannot appear in a UUID or a decimal integer, so the three fields
  // cannot be confused with one another. Without it, (txn "a", attempt 11) and
  // (txn "a1", attempt 1) would hash identically.
  const digest = createHash('sha256')
    .update(`${txnId}|${attemptNo}|${policyVersion}`)
    .digest('hex');

  return idempotencyKey(digest);
}
