/**
 * @rc/engine — the decision core.
 *
 * Plans one action per failed payment, executes it idempotently, and reconciles attempts
 * stranded by a crash. Deterministic given a clock and a gateway, which is what allows two
 * very different drivers to share it: the BullMQ worker, for the live streaming demo, and
 * the eval harness, which drives it directly because a queue's nondeterministic ordering
 * would break "same seed, same numbers".
 *
 * No model appears anywhere in this package. The LLM's contribution arrives upstream as a
 * classified `reasonCode`, and its influence ends there.
 */

export { deriveIdempotencyKey } from './idempotency.js';

export {
  type ContactPlan,
  type Plan,
  type PlanInput,
  type TemplateRef,
  planNext,
} from './plan.js';

export {
  type AttemptHistory,
  type PlanContext,
  type TxnContext,
  countRecentContacts,
  loadAttemptHistory,
  loadConsent,
  loadOpenPromise,
  loadPlanContext,
  loadPreDebitNoticeAt,
  loadTemplate,
  loadTxnContext,
} from './repository.js';

export {
  type ExecuteArgs,
  type ExecuteDeps,
  type ExecuteResult,
  executeDecision,
  reconcileStranded,
} from './execute.js';
