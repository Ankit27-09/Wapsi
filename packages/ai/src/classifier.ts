import type { Bps, Paise, ReasonCode } from '@rc/core';
import type { ClassifyMethod } from '@rc/db';

/**
 * THE CLASSIFIER PORT
 *
 * The LLM's entire contribution to this system arrives through this interface, and its
 * influence ends here: the result is a `reasonCode`, which the deterministic policy engine
 * then uses to look up a schedule and a published prior. No model output reaches an
 * arithmetic path, a retry decision, or a bound check.
 *
 * Three implementations, which are the three arms of the ablation:
 *
 *   `keyword` — a rule table over reason strings. The honest baseline.
 *   `llm`     — Claude, constrained to the taxonomy enum.
 *   `oracle`  — reads the simulator's seeded cause. Not shippable; it is the CEILING,
 *               and reporting the other two against it is what makes the ablation a
 *               measurement rather than a comparison of two guesses.
 */

export interface ClassificationInput {
  /** Untrusted free text from the gateway. The classifier's input and the injection surface. */
  readonly description: string;
  /** The gateway's own code, where it supplied one. Often absent or useless. */
  readonly gatewayCode: string | null;
}

export interface Classification {
  readonly reasonCode: ReasonCode;
  /** Calibrated confidence, in integer basis points to match the money convention. */
  readonly confidenceBps: Bps;
  readonly method: ClassifyMethod;
  /**
   * True when confidence fell below the floor, or the model returned something outside
   * the taxonomy. A quarantined transaction is reported as `unknown`, and no intervention
   * fires on an unclassified root cause — guessing would spend money on a coin flip.
   */
  readonly quarantined: boolean;

  readonly model: string | null;
  readonly promptHash: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly costPaise: Paise;
  readonly latencyMs: number;

  /**
   * Set when the model returned a code outside the taxonomy, or the request failed.
   *
   * Recorded rather than thrown: a classifier that cannot classify is a normal outcome
   * with a correct handling path (quarantine), not an exception. Throwing would abort a
   * batch over one unparseable string.
   */
  readonly error: string | null;
}

export interface Classifier {
  readonly method: ClassifyMethod;
  readonly model: string | null;
  classify(input: ClassificationInput): Promise<Classification>;
}
