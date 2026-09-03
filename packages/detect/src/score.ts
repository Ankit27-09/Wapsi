import type { Rail } from '@rc/core';
import { toBps } from '@rc/core';
import type { DegradationSignal } from './detect.js';

/**
 * How good is the detector? Measured, not asserted.
 *
 * The same move the oracle arm makes for recovery: a claim about performance is worth
 * nothing without something to measure it against. The simulator knows exactly when it
 * collapsed an issuer's authorisation rate and for how long. The detector never sees that —
 * it gets the authorisation stream and nothing else — so comparing its signals to the
 * episodes that actually happened gives precision and recall on real ground truth.
 *
 * THE WALL HOLDS. `@rc/detect` does not import the simulator, and cannot: this function
 * takes the episodes as an argument, and the only caller that can supply them is the
 * evaluation harness, which is allowed to read truth because grading is its whole job. The
 * detector and its scorer live in one package and share no data.
 *
 * Reported alongside recall because they trade off and one alone is easy to game. A detector
 * that fires on everything has perfect recall and is worthless; one that never fires has
 * perfect precision and is worse. The interesting number is the delay: an outage found
 * fifty minutes in has already cost most of what it was going to cost.
 */

/** An episode the simulator actually created. */
export interface KnownOutage {
  readonly issuerId: string;
  readonly rail: Rail;
  readonly start: Date;
  readonly end: Date;
}

export interface DetectionScore {
  readonly outages: number;
  /** Known outages with at least one signal overlapping them. */
  readonly found: number;
  /** Signals that overlap no known outage. */
  readonly falsePositives: number;
  readonly recallBps: number;
  readonly precisionBps: number;
  /**
   * Minutes from an outage beginning to the close of the first window that reported it,
   * averaged over the outages that were found.
   *
   * Measured to the window's CLOSE, not its start, because a rolling window cannot conclude
   * anything until it has finished accumulating. Measuring to the start would report a delay
   * shorter than the one an operator experiences, which is the flattering error.
   */
  readonly meanDelayMinutes: number | null;
}

function overlaps(
  signal: DegradationSignal,
  outage: KnownOutage,
): boolean {
  return (
    signal.issuerId === outage.issuerId &&
    signal.rail === outage.rail &&
    signal.windowStart.getTime() < outage.end.getTime() &&
    outage.start.getTime() < signal.windowEnd.getTime()
  );
}

export function scoreDetection(
  signals: readonly DegradationSignal[],
  outages: readonly KnownOutage[],
): DetectionScore {
  let found = 0;
  const delays: number[] = [];

  for (const outage of outages) {
    const hits = signals
      .filter((signal) => overlaps(signal, outage))
      .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());

    const first = hits[0];
    if (first === undefined) continue;

    found += 1;
    // `firstSeenAt`, not `windowEnd`. Coalescing extends a signal's window to cover the whole
    // episode, so a 90-minute outage caught after 30 would report a 90-minute lag.
    delays.push(
      Math.max(0, (first.firstSeenAt.getTime() - outage.start.getTime()) / 60_000),
    );
  }

  // A signal for a real outage on a cohort that was never degraded is a false positive even
  // if some OTHER cohort was degrading at the time — the point of naming the cohort is that
  // the name has to be right for the response to be right.
  const falsePositives = signals.filter(
    (signal) => !outages.some((outage) => overlaps(signal, outage)),
  ).length;

  const truePositives = signals.length - falsePositives;

  return {
    outages: outages.length,
    found,
    falsePositives,
    recallBps: outages.length === 0 ? 0 : toBps(found / outages.length),
    precisionBps: signals.length === 0 ? 0 : toBps(truePositives / signals.length),
    meanDelayMinutes:
      delays.length === 0
        ? null
        : delays.reduce((total, value) => total + value, 0) / delays.length,
  };
}
