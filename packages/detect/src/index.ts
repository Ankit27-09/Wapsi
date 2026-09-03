/**
 * @rc/detect — the first verb.
 *
 * "Build an agent that DETECTS revenue at risk, determines the right intervention, and
 * executes a bounded recovery workflow." Everything else in this repository serves the second
 * and third verbs, starting from transactions that had already failed and already been
 * triaged. This package is the first: it watches the merchant's authorisation stream and
 * finds a cohort going bad, which is a fact about a population and is invisible in any single
 * transaction inside it.
 *
 * It has no opinion about what to do next. It emits evidence — counts, a peer baseline, a
 * confidence bound and a verdict — and the policy engine decides. That separation is why the
 * detector can be tested against a known outage without any of the engine's machinery, and
 * why a signal can be argued with rather than merely obeyed.
 */

export {
  DEFAULT_DETECTOR,
  DEGRADATION_VERDICTS,
  type AuthObservation,
  type DegradationSignal,
  type DegradationVerdict,
  type DetectorConfig,
  detect,
  forbidsCharge,
  permitsRailSwitch,
} from './detect.js';

export {
  loadAuthStream,
  loadSignals,
  recordSignals,
  signalsAffecting,
} from './store.js';

// Re-exported for callers that only import this package. The types themselves live in
// @rc/core, so @rc/policy can act on a signal without depending on the detector.
// `DegradationVerdict` already arrives via `./detect.js`, which re-exports it from the same
// place — naming it twice here is a duplicate identifier, not a second definition.
export { NO_COHORT_RISK, type CohortRisk } from '@rc/core';

export { scoreDetection, type DetectionScore, type KnownOutage } from './score.js';
