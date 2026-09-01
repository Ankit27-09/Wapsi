/**
 * @rc/simulator — evaluation scaffolding.
 *
 * The seeded gateway, the ground-truth outcome model, and the batch generator. This
 * package is structurally forbidden from importing @rc/policy, and `apps/web` is
 * forbidden from importing this: it is the harness, not the product, and letting it leak
 * into either would mean the system stopped being a prototype of something real.
 */

export { type Rng, createRng, deriveRng } from './rng.js';

export {
  type Issuer,
  type TruthModel,
  type TruthTiming,
  buildTruthModel,
  loadTruthModel,
} from './truth.js';

export {
  type Difficulty,
  type FailureString,
  FAILURE_STRINGS,
  INJECTION_STRINGS,
  NOVEL_STRINGS,
  allLabelledStrings,
} from './strings.js';

export {
  type GenerateOptions,
  type GeneratedBatch,
  type PlannedTxn,
  DEFAULT_FEE_BUDGET_PER_TXN_PAISE,
  SIM_EPOCH,
  generateBatch,
  planTxns,
} from './generate.js';

export {
  type PerturbOptions,
  type TruthOverride,
  baselineTruthValue,
  perturbedTruth,
  truthWithOverride,
  truthWithOverrides,
} from './perturb.js';

export {
  type SimulatorGatewayOptions,
  TIMING_HOURS,
  createSimulatorGateway,
} from './gateway.js';

export { ensureTemplatesSeeded, registeredTemplates } from './templates.js';
