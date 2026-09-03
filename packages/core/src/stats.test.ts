import { describe, expect, it } from 'vitest';
import { Z_95, Z_99, toBps, wilsonLowerBound } from './stats.js';

/**
 * The guard that stops a degradation alert from firing on noise.
 *
 * These are not decorative. The detector's entire claim — that it finds a real issuer outage
 * without alerting on three unlucky customers — rests on the behaviour asserted here.
 */

describe('Wilson lower bound', () => {
  it('stays far below any sane baseline when everything failed but n is tiny', () => {
    // THE CASE THE DETECTOR EXISTS TO SURVIVE. Three consecutive failures on one issuer is
    // p ≈ 0.0007 against a 9% baseline, so a naive significance test fires — and it is
    // still the wrong call, because twenty cohorts watched continuously will throw a
    // three-in-a-row constantly, and switching every customer off that issuer costs real
    // money. The bound is what makes "significant" and "actionable" separable.
    const bound = wilsonLowerBound(3, 3, Z_95);
    expect(bound).toBeGreaterThan(0.4);
    expect(bound).toBeLessThan(0.5);
  });

  it('tightens toward the point estimate as evidence accumulates', () => {
    // Same observed rate, four sample sizes. This monotonicity is the whole mechanism.
    const rates = [10, 50, 200, 1000].map((n) => wilsonLowerBound(n * 0.6, n, Z_95));

    for (let i = 1; i < rates.length; i += 1) {
      expect(rates[i]!).toBeGreaterThan(rates[i - 1]!);
    }
    expect(rates.at(-1)!).toBeCloseTo(0.6, 1);
  });

  it('never reports certainty from a saturated sample, unlike the normal approximation', () => {
    // `p̂ ± z·√(p̂(1−p̂)/n)` has ZERO width at p̂ = 1, so it would return a lower bound of
    // 1.0 from a single failed authorisation. That is the specific defect Wilson is chosen
    // over it for, and it would have made the detector fire on every cohort's first failure.
    expect(wilsonLowerBound(1, 1, Z_95)).toBeLessThan(0.25);
    expect(wilsonLowerBound(50, 50, Z_95)).toBeLessThan(1);
  });

  it('is more conservative at 99% than at 95%', () => {
    expect(wilsonLowerBound(60, 100, Z_99)).toBeLessThan(wilsonLowerBound(60, 100, Z_95));
  });

  it('returns zero for an empty cohort rather than dividing by it', () => {
    expect(wilsonLowerBound(0, 0, Z_95)).toBe(0);
  });

  it('stays inside [0, 1] across the whole domain', () => {
    for (const n of [1, 3, 7, 40, 999]) {
      for (let k = 0; k <= n; k += Math.max(1, Math.floor(n / 7))) {
        const bound = wilsonLowerBound(k, n, Z_95);
        expect(bound).toBeGreaterThanOrEqual(0);
        expect(bound).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rejects inputs that are not counts, rather than returning a plausible number', () => {
    // A rate passed where a count belongs would silently produce a bound for the wrong
    // cohort size, which is the kind of wrong that looks right in a report.
    expect(() => wilsonLowerBound(0.6, 100, Z_95)).toThrow(/counts/);
    expect(() => wilsonLowerBound(101, 100, Z_95)).toThrow(/not a proportion/);
    expect(() => wilsonLowerBound(-1, 10, Z_95)).toThrow(/negative/);
    expect(() => wilsonLowerBound(5, 10, 0)).toThrow(/z must be positive/);
  });
});

describe('leaving float arithmetic', () => {
  it('rounds a rate to integer basis points', () => {
    expect(toBps(0.6)).toBe(6000);
    expect(toBps(0.60005)).toBe(6001);
    expect(toBps(0)).toBe(0);
    expect(toBps(1)).toBe(10_000);
  });

  it('clamps rather than emitting basis points outside the scale', () => {
    expect(toBps(1.4)).toBe(10_000);
    expect(toBps(-0.2)).toBe(0);
  });

  it('refuses a non-finite rate instead of producing NaN basis points', () => {
    // `NaN` here would reach the expected-value gate as a probability and silently poison
    // every comparison it took part in, since every comparison against NaN is false.
    expect(() => toBps(Number.NaN)).toThrow(/finite/);
    expect(() => toBps(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
