import { bps, type Bps } from '@rc/core';
import {
  baselineTruthValue,
  loadTruthModel,
  truthWithOverrides,
  type TruthModel,
} from '@rc/simulator';

/**
 * HOSTILE WORLDS
 *
 * The Monte Carlo sweep perturbs every prior independently, so the noise largely averages
 * out across three hundred transactions and the conclusion survives close to by
 * construction — 500 of 500 is a weaker result than it looks, and I would say so on the
 * slide. These are the sharper test: worlds where one load-bearing assumption is
 * SYSTEMATICALLY false, which is not noise and does not average away.
 *
 * THE SUCCESS CRITERION IS NOT THAT THE CONTROLLER STILL WINS.
 *
 * That would be a claim about luck. The criterion is that it FAILS GRACEFULLY: when its
 * premise is wrong, the expected-value gate should notice that attempts are not paying and
 * stop, landing near do-nothing rather than far below it. A recovery system whose downside
 * is bounded by its own economics is a different proposition from one that happens to be
 * right, and the difference only shows up in a world built to break it.
 *
 * A world where the controller loses money is a finding, and it goes in the report as one.
 */

export interface HostileWorld {
  readonly id: string;
  readonly label: string;
  /** The assumption this world falsifies, in the words a slide would use. */
  readonly assumption: string;
  readonly truth: TruthModel;
  readonly labelCorruptionBps?: Bps;
}

export function hostileWorlds(): readonly HostileWorld[] {
  return [flatSalaryWindow(), longOutages(), dirtyLabels()];
}

/**
 * H1 — the salary window does nothing.
 *
 * The controller's whole insight about insufficient funds is that a retry timed after the
 * customer's credit lands does materially better than one fired immediately. Here it does
 * not: every timing performs like the immediate attempt.
 *
 * If the strategy is mostly a bet on this one idea, this is the world that exposes it.
 */
function flatSalaryWindow(): HostileWorld {
  const flat = baselineTruthValue({
    reasonCode: 'insufficient_funds',
    attempt: 1,
    timing: 'immediate',
  });

  return {
    id: 'H1',
    label: 'Flat salary window',
    assumption: 'Retrying after a salary credit beats retrying immediately.',
    truth: truthWithOverrides([
      { reasonCode: 'insufficient_funds', attempt: 2, timing: 'salary_window', pBps: flat },
      { reasonCode: 'insufficient_funds', attempt: 1, timing: 'salary_window', pBps: flat },
      { reasonCode: 'insufficient_funds', attempt: 2, timing: 'next_day', pBps: flat },
      { reasonCode: 'insufficient_funds', attempt: 3, timing: 'next_day', pBps: flat },
    ]),
  };
}

/**
 * H2 — issuer outages outlast the backoff.
 *
 * The policy schedules 15 minutes, then a few hours, then a few hours again, on the belief
 * that most issuer incidents clear inside an hour. Here they last most of a day, so all
 * three attempts land inside the outage and every one of them is a wasted fee.
 *
 * This is the world that tests whether a mistuned schedule costs three fees per transaction
 * or whether the gate stops after the first.
 */
function longOutages(): HostileWorld {
  return {
    id: 'H2',
    label: 'Long issuer outages',
    assumption: 'Issuer incidents clear within an hour, so short backoff recovers them.',
    truth: truthWithOverrides([
      { reasonCode: 'issuer_down', attempt: 1, timing: 'short_backoff', pBps: 400 },
      { reasonCode: 'issuer_down', attempt: 2, timing: 'medium_backoff', pBps: 600 },
      { reasonCode: 'issuer_down', attempt: 3, timing: 'medium_backoff', pBps: 700 },
    ]),
  };
}

/**
 * H3 — one transaction in three is mislabelled.
 *
 * Attacks a different surface from the other two. H1 and H2 make the WORLD wrong; this
 * makes the policy's VIEW of the world wrong while the world behaves normally. The failure
 * mode differs: a wrong world wastes attempts that were never going to work, whereas a wrong
 * label sends a genuinely recoverable payment down a schedule built for a different cause.
 *
 * 30% is far worse than either measured classifier — the keyword baseline mislabels about
 * 3% of transactions outright and the model about 1% — so this is a deliberately punishing
 * upper bound rather than a forecast.
 */
function dirtyLabels(): HostileWorld {
  return {
    id: 'H3',
    label: 'Dirty labels (30% mislabelled)',
    assumption: 'The classifier identifies the cause correctly.',
    truth: loadTruthModel(),
    labelCorruptionBps: bps(3000),
  };
}
