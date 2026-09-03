import { ReasonCodeSchema, BPS_ONE, ZERO, bps } from '@rc/core';
import type { Classification, ClassificationInput, Classifier } from './classifier.js';

/**
 * THE ORACLE CLASSIFIER — the ceiling, not an arm to ship
 *
 * Reads the seeded cause the simulator recorded, so classification is perfect by
 * construction. Not a strategy: a MEASUREMENT DEVICE.
 *
 * Its purpose is to separate two things the headline figure otherwise conflates. When the
 * Wapsi recovers less than it might have, the shortfall has two possible
 * sources — the policy chose badly, or the classifier mislabelled the cause and the policy
 * then executed the wrong plan correctly. Running the identical policy against perfect
 * labels isolates the second, and the gap between the oracle and the keyword or LLM arms
 * IS the cost of imperfect classification, in rupees.
 *
 * Without this arm, "the LLM improved recovery by X%" is a comparison of two guesses with
 * no scale. With it, both arms are reported as a fraction of what was achievable.
 *
 * The cause is supplied by the caller (the eval harness reads it from the simulator's
 * record); this module never queries anything. That keeps `@rc/ai` free of any dependency
 * on the simulator, so the Chinese wall is unaffected.
 */

export interface OracleInput extends ClassificationInput {
  /**
   * The true cause, from the simulator's seeded record.
   *
   * Present only in the eval harness. No production path can supply it, which is the
   * point: an arm that cannot be deployed cannot be mistaken for the product.
   */
  readonly trueReasonCode: string;
}

export function createOracleClassifier(): Classifier & {
  classifyWithTruth(input: OracleInput): Promise<Classification>;
} {
  const classify = (input: OracleInput): Promise<Classification> =>
    Promise.resolve({
      // Validated rather than trusted. If the seeded cause ever falls outside the
      // taxonomy, that is a generator bug and it should surface here loudly rather than
      // quietly become an unknown.
      reasonCode: ReasonCodeSchema.parse(input.trueReasonCode),
      confidenceBps: bps(BPS_ONE),
      method: 'oracle',
      quarantined: false,
      model: 'oracle',
      promptHash: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costPaise: ZERO,
      latencyMs: 0,
      error: null,
    });

  return {
    method: 'oracle',
    model: 'oracle',

    classify(): Promise<Classification> {
      throw new Error(
        'The oracle classifier requires the seeded cause. Call classifyWithTruth() from ' +
          'the eval harness — there is no production path that can supply it.',
      );
    },

    classifyWithTruth: classify,
  };
}

export const ORACLE_CLASSIFIER = createOracleClassifier();
