import { describe, expect, it } from 'vitest';
import type { Rail } from '@rc/core';
import {
  DEFAULT_DETECTOR,
  detect,
  forbidsCharge,
  permitsRailSwitch,
  type AuthObservation,
  type DetectorConfig,
} from './detect.js';
import { NO_COHORT_RISK, signalsAffecting } from './store.js';
import { scoreDetection } from './score.js';

/**
 * The detector's claim is that it finds a real outage and does not fire on noise. Both halves
 * are asserted here, and the second half is the one that matters — a detector that alerts
 * freely is worse than none, because every alert here costs a rail switch.
 */

const T0 = new Date('2026-03-02T10:00:00Z');

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/** Build `count` attempts for one cohort spread across `[from, from+spanMinutes)`. */
function traffic(spec: {
  issuerId: string;
  rail?: Rail;
  from: number;
  spanMinutes: number;
  count: number;
  failureBps: number;
  reasonCode?: AuthObservation['reasonCode'];
  binBucket?: string | null;
}): AuthObservation[] {
  const rail: Rail = spec.rail ?? 'card';
  const out: AuthObservation[] = [];

  // Exact AND evenly spread. A seeded RNG would make every rate assertion approximate, and
  // these tests turn on boundaries where "about 70%" decides whether they pass. But taking
  // the first `failCount` of the sequence — the obvious way to get an exact count — puts
  // every failure at the front of the time span, so the first rolling window sees 100% and
  // the last sees 0%. That produced three spurious failures here and would have been read as
  // detector bugs. Bresenham-style distribution keeps the count exact and the rate flat.
  const failCount = Math.round(spec.count * (spec.failureBps / 10_000));

  for (let i = 0; i < spec.count; i += 1) {
    const isFailure =
      Math.floor(((i + 1) * failCount) / spec.count) > Math.floor((i * failCount) / spec.count);

    out.push({
      issuerId: spec.issuerId,
      rail,
      binBucket: spec.binBucket === undefined ? 'BIN_41' : spec.binBucket,
      succeeded: !isFailure,
      reasonCode: isFailure ? (spec.reasonCode ?? 'issuer_down') : null,
      occurredAt: at(spec.from + (i * spec.spanMinutes) / spec.count),
    });
  }

  return out;
}

/** A healthy book: four issuers on card, all failing at a normal ~9%. */
function healthyBook(fromMinutes: number, spanMinutes: number): AuthObservation[] {
  return ['ISS_NORTH', 'ISS_SOUTH', 'ISS_EAST', 'ISS_WEST'].flatMap((issuerId) =>
    traffic({ issuerId, from: fromMinutes, spanMinutes, count: 120, failureBps: 900 }),
  );
}

describe('finding a real outage', () => {
  it('names the degraded cohort and leaves its healthy peers alone', () => {
    const signals = detect([
      ...healthyBook(0, 120),
      // ISS_COOP collapses to 70% failure for the middle hour.
      ...traffic({ issuerId: 'ISS_COOP', from: 0, spanMinutes: 30, count: 80, failureBps: 900 }),
      ...traffic({ issuerId: 'ISS_COOP', from: 30, spanMinutes: 60, count: 200, failureBps: 7000 }),
      ...traffic({ issuerId: 'ISS_COOP', from: 90, spanMinutes: 30, count: 80, failureBps: 900 }),
    ]);

    const cohorts = new Set(signals.map((signal) => signal.issuerId));
    expect(cohorts).toEqual(new Set(['ISS_COOP']));
    expect(signals.every((signal) => signal.verdict === 'issuer_outage')).toBe(true);
  });

  it('judges against the contemporaneous peer rate, not a configured constant', () => {
    const signals = detect([
      ...healthyBook(0, 120),
      ...traffic({ issuerId: 'ISS_COOP', from: 20, spanMinutes: 60, count: 200, failureBps: 7000 }),
    ]);

    expect(signals.length).toBeGreaterThan(0);
    const signal = signals[0]!;
    // The baseline is the peers' ~9%, discovered from the same window.
    expect(signal.baselineBps).toBeGreaterThan(600);
    expect(signal.baselineBps).toBeLessThan(1200);
    expect(signal.observedBps).toBeGreaterThan(6000);
    // And the bound that licensed the alert sits below the point estimate.
    expect(signal.lowerBoundBps).toBeLessThan(signal.observedBps);
    expect(signal.lowerBoundBps).toBeGreaterThan(signal.baselineBps);
  });

  it('identifies the dominant cause, which is what selects the response', () => {
    const signals = detect([
      ...healthyBook(0, 120),
      ...traffic({
        issuerId: 'ISS_COOP',
        from: 20,
        spanMinutes: 60,
        count: 200,
        failureBps: 7000,
        reasonCode: 'issuer_down',
      }),
    ]);

    expect(signals[0]!.dominantCode).toBe('issuer_down');
  });

  it('coalesces one outage into one signal instead of a dozen overlapping windows', () => {
    // A 90-minute outage through 30-minute windows stepping 10 produces ~10 candidates. A
    // report counting those would say the detector found ten degradations, which is a
    // fabricated number, and an operator could not tell ten outages from one.
    const signals = detect([
      ...healthyBook(0, 180),
      ...traffic({ issuerId: 'ISS_COOP', from: 30, spanMinutes: 90, count: 300, failureBps: 7000 }),
    ]);

    const coop = signals.filter((signal) => signal.issuerId === 'ISS_COOP');
    expect(coop).toHaveLength(1);
    // And the merged window covers the episode rather than one 30-minute slice of it.
    const spanMinutes =
      (coop[0]!.windowEnd.getTime() - coop[0]!.windowStart.getTime()) / 60_000;
    expect(spanMinutes).toBeGreaterThan(60);
  });
});

describe('not firing on noise', () => {
  it('reports nothing on a healthy book', () => {
    expect(detect(healthyBook(0, 180))).toEqual([]);
  });

  it('does not fire on a tiny cohort even when every attempt failed', () => {
    // THE CASE THE USER ASKED FOR EXPLICITLY. Three failures out of three is p ≈ 0.0007
    // against a 9% baseline — statistically significant, operationally noise. Both guards
    // refuse it: the sample is under the materiality floor, and the Wilson bound at n=3
    // could not clear the baseline by the required margin anyway.
    const signals = detect([
      ...healthyBook(0, 120),
      ...traffic({ issuerId: 'ISS_TINY', from: 20, spanMinutes: 5, count: 3, failureBps: 10_000 }),
    ]);

    expect(signals.filter((signal) => signal.issuerId === 'ISS_TINY')).toEqual([]);
  });

  it('ignores a small elevation that is real but not worth a rail switch', () => {
    // 14% against a 9% baseline on a large sample IS statistically significant. It is not
    // worth moving anybody's traffic over, so `minExcessBps` refuses it. Significance and
    // materiality are separate questions and this asserts they stay separate.
    const signals = detect([
      ...healthyBook(0, 120),
      ...traffic({ issuerId: 'ISS_MEH', from: 0, spanMinutes: 120, count: 600, failureBps: 1400 }),
    ]);

    expect(signals.filter((signal) => signal.issuerId === 'ISS_MEH')).toEqual([]);
  });

  it('will not compute a baseline from a cohort that has no peers', () => {
    // One issuer alone on a rail. There is nothing to compare it to, and "we cannot tell"
    // is the correct answer — inventing a baseline here is how a detector starts reporting
    // its own configuration back as a finding.
    const signals = detect(
      traffic({
        issuerId: 'ISS_ONLY',
        rail: 'wallet',
        from: 0,
        spanMinutes: 60,
        count: 200,
        failureBps: 6000,
      }),
    );

    expect(signals.filter((signal) => signal.verdict === 'issuer_outage')).toEqual([]);
  });
});

describe('telling apart the three things that go wrong', () => {
  it('calls it a rail problem when every cohort on the rail is bad', () => {
    // A peer comparison is structurally blind to this: if all issuers fail at 60%, none is
    // anomalous relative to the others and a peer-only detector reports a clean book during
    // a total outage.
    const signals = detect(
      ['ISS_NORTH', 'ISS_SOUTH', 'ISS_EAST'].flatMap((issuerId) =>
        traffic({ issuerId, from: 0, spanMinutes: 60, count: 200, failureBps: 6000 }),
      ),
    );

    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.verdict === 'rail_degraded')).toBe(true);
  });

  it('calls a fraud-rule concentration by its own name, not an outage', () => {
    const signals = detect([
      ...healthyBook(0, 120),
      ...traffic({
        issuerId: 'ISS_COOP',
        from: 20,
        spanMinutes: 60,
        count: 200,
        failureBps: 7000,
        reasonCode: 'suspected_fraud_block',
      }),
    ]);

    const coop = signals.filter((signal) => signal.issuerId === 'ISS_COOP');
    expect(coop).toHaveLength(1);
    expect(coop[0]!.verdict).toBe('fraud_rule');
  });

  it('permits a rail switch for an outage and forbids one for a fraud rule', () => {
    // The distinction the verdicts exist for. A fraud rule travels with the card, so
    // switching rails to get around one is futile and is how a merchant's acquirer
    // relationship gets reviewed.
    expect(forbidsCharge('issuer_outage')).toBe(true);
    expect(permitsRailSwitch('issuer_outage')).toBe(true);

    expect(forbidsCharge('fraud_rule')).toBe(true);
    expect(permitsRailSwitch('fraud_rule')).toBe(false);

    // A degraded rail must NOT forbid charging, or the whole recovery book stops over a
    // condition every alternative rail shares.
    expect(forbidsCharge('rail_degraded')).toBe(false);
  });
});

describe('a signal is bounded in time, not a permanent mark', () => {
  const signals = detect([
    ...healthyBook(0, 180),
    ...traffic({ issuerId: 'ISS_COOP', from: 30, spanMinutes: 60, count: 200, failureBps: 7000 }),
  ]);

  it('suppresses charges inside the window', () => {
    const risk = signalsAffecting(signals, {
      issuerId: 'ISS_COOP',
      rail: 'card',
      at: at(60),
    });

    expect(risk.degraded).toBe(true);
    expect(risk.chargeForbidden).toBe(true);
    expect(risk.railSwitchPermitted).toBe(true);
  });

  it('stops suppressing once the window has passed', () => {
    // Without this, the first outage a system ever detects disables that issuer for the
    // remainder of the batch, and the recovery book shrinks for a reason nobody can see.
    const risk = signalsAffecting(signals, {
      issuerId: 'ISS_COOP',
      rail: 'card',
      at: at(175),
    });

    expect(risk).toEqual(NO_COHORT_RISK);
  });

  it('does not suppress a different cohort', () => {
    expect(
      signalsAffecting(signals, { issuerId: 'ISS_NORTH', rail: 'card', at: at(60) }).degraded,
    ).toBe(false);
    expect(
      signalsAffecting(signals, { issuerId: 'ISS_COOP', rail: 'upi_intent', at: at(60) }).degraded,
    ).toBe(false);
  });

  it('treats a transaction with no known issuer as unaffected', () => {
    // Batches seeded before `014_degradation.sql` have no issuer on the row. They must fall
    // through to the pre-detection behaviour rather than matching some arbitrary cohort.
    expect(
      signalsAffecting(signals, { issuerId: null, rail: 'card', at: at(60) }),
    ).toEqual(NO_COHORT_RISK);
  });
});

describe('scoring the detector against outages that actually happened', () => {
  const outage = {
    issuerId: 'ISS_COOP',
    rail: 'card' as Rail,
    start: at(30),
    end: at(90),
  };

  const signals = detect([
    ...healthyBook(0, 180),
    ...traffic({ issuerId: 'ISS_COOP', from: 30, spanMinutes: 60, count: 200, failureBps: 7000 }),
  ]);

  it('recalls the episode and reports how late it was', () => {
    const score = scoreDetection(signals, [outage]);

    expect(score.outages).toBe(1);
    expect(score.found).toBe(1);
    expect(score.recallBps).toBe(10_000);
    expect(score.falsePositives).toBe(0);
    // Measured to the close of the first firing window, because a rolling window concludes
    // nothing until it has finished accumulating.
    expect(score.meanDelayMinutes).not.toBeNull();
    expect(score.meanDelayMinutes!).toBeGreaterThan(0);
    expect(score.meanDelayMinutes!).toBeLessThanOrEqual(DEFAULT_DETECTOR.windowMinutes + 1);
  });

  it('counts a signal on a cohort that never degraded as a false positive', () => {
    const score = scoreDetection(signals, [
      { ...outage, issuerId: 'ISS_NORTH' },
    ]);

    expect(score.found).toBe(0);
    expect(score.falsePositives).toBe(signals.length);
    expect(score.precisionBps).toBe(0);
  });

  it('reports zero rather than dividing by an empty set', () => {
    expect(scoreDetection([], []).recallBps).toBe(0);
    expect(scoreDetection([], []).precisionBps).toBe(0);
    expect(scoreDetection([], []).meanDelayMinutes).toBeNull();
  });
});

describe('configuration is refused rather than coerced', () => {
  it('rejects a non-positive window or step', () => {
    const bad: DetectorConfig = { ...DEFAULT_DETECTOR, stepMinutes: 0 };
    expect(() => detect(healthyBook(0, 60), bad)).toThrow(/positive/);
  });

  it('returns nothing for an empty stream', () => {
    expect(detect([])).toEqual([]);
  });

  it('does not depend on the order rows arrive in', () => {
    const stream = [
      ...healthyBook(0, 120),
      ...traffic({ issuerId: 'ISS_COOP', from: 30, spanMinutes: 60, count: 200, failureBps: 7000 }),
    ];
    const shuffled = [...stream].reverse();

    expect(detect(shuffled)).toEqual(detect(stream));
  });
});
