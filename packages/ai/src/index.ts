/**
 * @rc/ai — classification, and nothing else.
 *
 * The only package in the system that talks to a model. Its output is a `reasonCode` and a
 * calibrated confidence; the deterministic policy engine takes it from there. No value
 * produced here reaches an arithmetic path, a retry decision, or a bound check — which is
 * what makes "the LLM is out of the money path" a structural fact rather than a claim.
 */

export type {
  Classification,
  ClassificationInput,
  Classifier,
} from './classifier.js';

export {
  type TokenUsage,
  NO_COST,
  isPricedModel,
  modelCallCost,
} from './cost.js';

export { KEYWORD_CLASSIFIER, classifyByKeyword } from './keyword.js';

export {
  type LlmClassifierOptions,
  classificationSystemPrompt,
  createLlmClassifier,
  permittedCodes,
} from './llm.js';

export { ORACLE_CLASSIFIER, createOracleClassifier } from './oracle.js';

export {
  type ParsedProposal,
  type ProposalEvidence,
  type ProposalResult,
  type ProposedChange,
  type ProposerOptions,
  type TunableField,
  ProposalSchema,
  TUNABLE_FIELDS,
  changeIsInRange,
  createProposer,
} from './proposer.js';
