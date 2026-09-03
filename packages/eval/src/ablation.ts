import type { ReasonCode } from '@rc/core';
import { REASON_CODES } from '@rc/core';
import type { Classifier } from '@rc/ai';
import { allLabelledStrings, type Difficulty } from '@rc/simulator';

/**
 * THE ABLATION — is the model worth its place?
 *
 * Two halves, and the second is the one that matters.
 *
 * ACCURACY (this module) answers "how often is the label right?", split by how hard the
 * string is. Cheap to compute, needs no database, and is the number every other project
 * would report.
 *
 * RUPEES (`runner.ts`, driving the full policy with each classifier) answers "what does
 * being wrong cost?". A misclassification is not an abstract error here: it sends a
 * genuinely recoverable payment down the wrong schedule, or fires a retry against a
 * revoked mandate. Currency is the correct unit for a classifier inside a payments system,
 * and reporting it is the part almost nobody does.
 *
 * The honest outcome is whichever one the numbers give. If the keyword baseline captures
 * the same net value, the model does not belong in this loop and that goes in the report.
 */

export interface ConfusionEntry {
  readonly expected: ReasonCode;
  readonly actual: ReasonCode;
  readonly text: string;
  readonly difficulty: Difficulty;
  readonly quarantined: boolean;
}

export interface AccuracyReport {
  readonly method: string;
  readonly model: string | null;
  readonly total: number;
  readonly correct: number;
  readonly accuracyBps: number;
  /**
   * Unweighted mean of per-class F1.
   *
   * Macro rather than micro on purpose: the batch is dominated by two or three common
   * causes, and a micro average would let a classifier score well while being useless on
   * `mandate_expired` — which happens to be one of the classes where acting on a wrong
   * label wastes the most money.
   */
  readonly macroF1Bps: number;
  readonly byDifficulty: Readonly<Record<Difficulty, { correct: number; total: number }>>;
  /**
   * Quarantined rather than wrong.
   *
   * Counted separately because these are not failures. A classifier that says "I do not
   * know" on an opaque string is behaving correctly — the transaction goes to a human, no
   * fee is spent, and no customer is messaged about a cause nobody identified.
   */
  readonly quarantined: number;
  readonly mistakes: readonly ConfusionEntry[];
  readonly totalCostPaise: bigint;
  readonly p50LatencyMs: number;
  /** Per-item outcomes, kept so calibration can be computed without re-running the model. */
  readonly predictions: readonly Prediction[];
}

export interface Prediction {
  readonly confidenceBps: number;
  readonly correct: boolean;
  readonly quarantined: boolean;
}

/**
 * Score one classifier against the hand-labelled corpus.
 *
 * The corpus spans three difficulty tiers by construction, so a classifier cannot score
 * well by handling only the easy half. See `simulator/src/strings.ts` for why the tiers
 * exist and what each is meant to expose.
 *
 * SERIAL, AND IT REPORTS ITS PROGRESS. 113 strings against a model on a free tier, with a
 * retry ladder behind each one, is minutes of work — and it used to print nothing at all,
 * which made a slow phase indistinguishable from a hung one. It was reported as a hang, and
 * fairly: eight minutes of silence is a hang as far as anyone watching is concerned.
 *
 * Serial rather than concurrent deliberately: the accuracy figure must not depend on how
 * many requests happened to be in flight, and on a throttled key concurrency is what turns
 * a slow run into a rate-limited one. `onProgress` is how it stops being silent instead.
 */
export async function scoreClassifier(
  classifier: Classifier,
  onProgress?: (done: number, total: number) => void,
): Promise<AccuracyReport> {
  const corpus = allLabelledStrings();

  const byDifficulty: Record<Difficulty, { correct: number; total: number }> = {
    easy: { correct: 0, total: 0 },
    hard: { correct: 0, total: 0 },
    opaque: { correct: 0, total: 0 },
  };

  const mistakes: ConfusionEntry[] = [];
  const predictions: Prediction[] = [];
  const latencies: number[] = [];
  const truePositives = new Map<ReasonCode, number>();
  const falsePositives = new Map<ReasonCode, number>();
  const falseNegatives = new Map<ReasonCode, number>();

  let correct = 0;
  let quarantined = 0;
  let totalCostPaise = 0n;

  for (const item of corpus) {
    const result = await classifier.classify({
      description: item.text,
      gatewayCode: null,
    });

    latencies.push(result.latencyMs);
    totalCostPaise += result.costPaise;
    onProgress?.(latencies.length, corpus.length);

    const tier = byDifficulty[item.difficulty];
    tier.total += 1;

    if (result.quarantined) quarantined += 1;

    predictions.push({
      confidenceBps: result.confidenceBps,
      correct: result.reasonCode === item.code,
      quarantined: result.quarantined,
    });

    if (result.reasonCode === item.code) {
      correct += 1;
      tier.correct += 1;
      bump(truePositives, item.code);
    } else {
      bump(falsePositives, result.reasonCode);
      bump(falseNegatives, item.code);
      mistakes.push({
        expected: item.code,
        actual: result.reasonCode,
        text: item.text,
        difficulty: item.difficulty,
        quarantined: result.quarantined,
      });
    }
  }

  return {
    method: classifier.method,
    model: classifier.model,
    total: corpus.length,
    correct,
    accuracyBps: corpus.length === 0 ? 0 : Math.round((correct / corpus.length) * 10_000),
    macroF1Bps: macroF1Bps(truePositives, falsePositives, falseNegatives),
    byDifficulty,
    quarantined,
    mistakes,
    totalCostPaise,
    p50LatencyMs: median(latencies),
    predictions,
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * CALIBRATION — is the confidence worth anything?
 *
 * The classifier's confidence decides whether the system ACTS or QUARANTINES, so it is not
 * decoration: a number that says 0.9 and is right 60% of the time will spend money on a
 * cause nobody has actually identified. Accuracy tells you how often the label is right;
 * calibration tells you whether the model KNOWS when it is right, which is the property the
 * threshold depends on.
 *
 * Expected calibration error is the headline: bin predictions by stated confidence, compare
 * each bin's mean confidence against its actual accuracy, and average the gaps weighted by
 * bin size. Zero means confidence is exactly trustworthy; a large positive gap means
 * overconfidence, which is the dangerous direction — it produces action where quarantine
 * was warranted.
 *
 * The operating-point table exists so the threshold is CHOSEN FROM A CURVE rather than
 * picked by feel. That is the difference between "we quarantine below 0.6" and "0.6 is where
 * the accuracy of what we act on stops improving fast enough to justify the coverage we
 * give up".
 */
export interface CalibrationBin {
  readonly lowerBps: number;
  readonly upperBps: number;
  readonly count: number;
  readonly meanConfidenceBps: number;
  readonly accuracyBps: number;
}

export interface OperatingPoint {
  readonly thresholdBps: number;
  /** Share of the corpus the system would act on at this threshold. */
  readonly coverageBps: number;
  /** Accuracy among the items it would act on — the number that costs money when wrong. */
  readonly accuracyBps: number;
  /** Items acted on and wrong. Each one is a fee spent executing the wrong plan. */
  readonly actedAndWrong: number;
}

export interface CalibrationReport {
  readonly method: string;
  readonly bins: readonly CalibrationBin[];
  /** Expected calibration error, in basis points. Lower is better; zero is perfect. */
  readonly eceBps: number;
  /** Positive means overconfident — the dangerous direction. */
  readonly overconfidenceBps: number;
  readonly operatingPoints: readonly OperatingPoint[];
}

const BIN_EDGES = [0, 2_000, 4_000, 6_000, 7_500, 9_000, 10_001] as const;

export function calibrate(report: AccuracyReport): CalibrationReport {
  const bins: CalibrationBin[] = [];
  let weightedGap = 0;
  let confidenceSum = 0;
  let correctSum = 0;

  for (let i = 0; i < BIN_EDGES.length - 1; i += 1) {
    const lower = BIN_EDGES[i] ?? 0;
    const upper = BIN_EDGES[i + 1] ?? 10_001;

    const inBin = report.predictions.filter(
      (p) => p.confidenceBps >= lower && p.confidenceBps < upper,
    );
    if (inBin.length === 0) continue;

    const meanConfidence = Math.round(
      inBin.reduce((sum, p) => sum + p.confidenceBps, 0) / inBin.length,
    );
    const accuracy = Math.round(
      (inBin.filter((p) => p.correct).length / inBin.length) * 10_000,
    );

    bins.push({
      lowerBps: lower,
      upperBps: upper,
      count: inBin.length,
      meanConfidenceBps: meanConfidence,
      accuracyBps: accuracy,
    });

    weightedGap += (inBin.length / report.predictions.length) * Math.abs(meanConfidence - accuracy);
    confidenceSum += inBin.reduce((sum, p) => sum + p.confidenceBps, 0);
    correctSum += inBin.filter((p) => p.correct).length;
  }

  const total = report.predictions.length;

  return {
    method: report.method,
    bins,
    eceBps: Math.round(weightedGap),
    overconfidenceBps:
      total === 0
        ? 0
        : Math.round(confidenceSum / total - (correctSum / total) * 10_000),
    operatingPoints: BIN_EDGES.slice(0, -1).map((threshold) =>
      operatingPointAt(report.predictions, threshold),
    ),
  };
}

/**
 * What acting above a given confidence would look like.
 *
 * Coverage falls and accuracy rises as the threshold climbs; the useful question is where
 * that trade stops being worth it. `actedAndWrong` is the column that matters, because each
 * of those is a real fee spent executing a plan for the wrong failure.
 */
function operatingPointAt(
  predictions: readonly Prediction[],
  thresholdBps: number,
): OperatingPoint {
  const acted = predictions.filter((p) => p.confidenceBps >= thresholdBps);
  const correct = acted.filter((p) => p.correct).length;

  return {
    thresholdBps,
    coverageBps:
      predictions.length === 0 ? 0 : Math.round((acted.length / predictions.length) * 10_000),
    accuracyBps: acted.length === 0 ? 0 : Math.round((correct / acted.length) * 10_000),
    actedAndWrong: acted.length - correct,
  };
}

function bump(counter: Map<ReasonCode, number>, key: ReasonCode): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * Macro-averaged F1, in basis points.
 *
 * Classes that never appear in either the truth or the predictions are skipped rather than
 * scored as zero. Counting an absent class as a zero would drag the average down by an
 * amount that depends on how many classes the taxonomy happens to have — which would make
 * the figure a property of the taxonomy's size rather than of the classifier.
 */
function macroF1Bps(
  truePositives: ReadonlyMap<ReasonCode, number>,
  falsePositives: ReadonlyMap<ReasonCode, number>,
  falseNegatives: ReadonlyMap<ReasonCode, number>,
): number {
  const scores: number[] = [];

  for (const code of REASON_CODES) {
    const tp = truePositives.get(code) ?? 0;
    const fp = falsePositives.get(code) ?? 0;
    const fn = falseNegatives.get(code) ?? 0;
    if (tp + fp + fn === 0) continue;

    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    scores.push(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall));
  }

  if (scores.length === 0) return 0;
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10_000);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 0 ? Math.round((lower + upper) / 2) : upper;
}
