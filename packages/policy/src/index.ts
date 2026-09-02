/**
 * @rc/policy — the deterministic half of the system.
 *
 * Published success priors, the expected-value gate, and bounds checking. Every retry
 * decision, every timing calculation and every rupee of arithmetic happens here, in pure
 * functions, with no model anywhere in the path.
 *
 * This package is structurally forbidden from importing @rc/simulator, in two independent
 * layers — an ESLint rule on the import specifier and a dependency-cruiser rule on the
 * resolved graph. The policy is required to be capable of being WRONG about the world,
 * because that is the only condition under which a measured recovery result carries
 * information rather than restating its own assumptions.
 */

export {
  type PriorKind,
  type PriorLookup,
  type PriorRow,
  type PriorTable,
  type Source,
  type Timing,
  PRIOR_KINDS,
  PriorKindSchema,
  TIMINGS,
  TimingSchema,
  buildPriorTable,
  loadPriorTable,
  priorKindFor,
} from './priors.js';

export {
  type Policy,
  type ReasonPolicy,
  type ScheduleEntry,
  buildPolicy,
  loadPolicy,
  timingFor,
} from './policy.js';

export { type EvArithmetic, type EvInput, type EvVerdict, evGate, expected } from './ev.js';

export {
  type AttemptBound,
  type AttemptBoundsInput,
  type BoundsVerdict,
  type ConsentState,
  type ContactBound,
  type ContactBoundsInput,
  checkAttemptBounds,
  checkContactBounds,
} from './bounds.js';
