/**
 * The evidence primitives. Small, pure, and the one place in this codebase where a
 * floating-point number is the right answer.
 *
 * WHY FLOATS ARE PERMITTED HERE, having been banned everywhere else.
 *
 * Money is `bigint` paise and probability is integer basis points, because a rounding error
 * in the money path is a rupee that does not exist. None of that applies to a confidence
 * interval: it is not money, it is not stored, it is not summed across three hundred rows,
 * and its output is a BOOLEAN — "is this cohort degrading?" — not an amount. A square root is
 * unavoidable in a Wilson bound, and faking one in fixed point would add error to the
 * statistic to preserve a rule whose reason does not reach it.
 *
 * The boundary is enforced by where the result goes: a detector emits a signal, and the
 * expected-value gate that acts on it takes integer basis points. Nothing crosses.
 */

/**
 * Lower bound of the Wilson score interval on a binomial proportion.
 *
 * THE STATISTIC THAT MAKES SMALL SAMPLES SAFE. The naive test — "failure rate above
 * threshold" — fires on the first two failures a cohort ever sees, because 2/2 is 100%. The
 * Wilson interval answers a different and correct question: given this many observations,
 * what is the LOWEST failure rate consistent with what we saw? At n=2 that is about 0.22 even
 * when both failed, which is below any sane baseline, so the alert does not fire. At n=200
 * with the same observed rate the bound tightens to nearly the point estimate and it does.
 *
 * Wilson rather than the textbook normal approximation (`p̂ ± z·√(p̂(1−p̂)/n)`), which is
 * degenerate exactly where this is used: at p̂ = 1 it has zero width, so it would report
 * certainty from a single failure — the precise failure being guarded against. Wilson stays
 * inside [0, 1] and keeps sensible width at the extremes.
 *
 * @param successes count of the outcome being measured (here: failed authorisations)
 * @param total     total observations in the cohort
 * @param z         normal quantile; 1.96 ≈ 95% two-sided, 2.576 ≈ 99%
 * @returns lower bound in [0, 1]; 0 when `total` is 0
 */
export function wilsonLowerBound(successes: number, total: number, z: number): number {
  if (!Number.isInteger(successes) || !Number.isInteger(total)) {
    throw new Error('wilsonLowerBound takes counts, not rates');
  }
  if (successes < 0 || total < 0) throw new Error('counts cannot be negative');
  if (successes > total) throw new Error(`${successes} successes of ${total} is not a proportion`);
  if (total === 0) return 0;
  if (z <= 0) throw new Error('z must be positive');

  const n = total;
  const phat = successes / n;
  const z2 = z * z;

  const denominator = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denominator;
  const halfWidth =
    (z / denominator) * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n));

  // Clamped because floating error can put the bound a hair below zero at p̂ = 0.
  return Math.max(0, Math.min(1, centre - halfWidth));
}

/** Conventional two-sided normal quantiles, named so a call site reads as its confidence. */
export const Z_95 = 1.96;
export const Z_99 = 2.5758293035489004;

/**
 * A proportion as integer basis points, rounded half-up.
 *
 * The exit from float arithmetic back into the integer world the rest of the system uses.
 */
export function toBps(rate: number): number {
  if (!Number.isFinite(rate)) throw new Error('rate must be finite');
  return Math.round(Math.max(0, Math.min(1, rate)) * 10_000);
}
