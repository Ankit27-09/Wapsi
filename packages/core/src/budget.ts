import { ZERO, add, formatINR, gte, type Paise } from './money.js';

/**
 * THE MODEL SPEND CEILING
 *
 * A hard cap on how many model calls a batch may make and how many rupees they may cost.
 * Breaching either one halts the batch.
 *
 * WHY THIS EXISTS AS A MECHANISM RATHER THAN A HABIT.
 *
 * This system runs an agent in a loop over a few hundred transactions. Every other cost in it
 * is bounded by something structural — gateway fees by `batch_budget`, message sends by the
 * weekly contact ceiling, attempts by the schedule length. Model spend was bounded by nothing
 * at all: a longer batch, a retry loop, or a model that starts returning longer completions
 * would keep calling until the work ran out, and the first anyone would know of it is the
 * invoice.
 *
 * The ceilings were DOCUMENTED in `.env.example` and enforced nowhere, which is worse than
 * absent. A claimed control that does not exist invites a reader to doubt the ones that do.
 *
 * THE CHECK RUNS BEFORE THE CALL, not after. Recording an overspend and then halting is an
 * audit trail of the thing the ceiling existed to prevent — the point is that the call which
 * would breach the cap never happens. So `reserve()` is consulted first and `settle()` records
 * what the call actually cost, which is the same reserve-then-settle shape `batch_budget` uses
 * for gateway fees.
 *
 * A cost ceiling cannot be exact, and pretending otherwise would be the dishonest option: the
 * cost of a call is known only once it returns, so the LAST call before the cap may take the
 * total past it. `reserve()` therefore refuses when the ceiling is already reached, which
 * bounds the overshoot to one call rather than to none. Stated here rather than discovered by
 * someone reconciling the ledger.
 */

export type BudgetBreach = 'call_ceiling' | 'cost_ceiling';

export interface BudgetLimits {
  readonly maxCalls: number;
  readonly maxCostPaise: Paise;
}

export type Reservation =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'breach';
      readonly rule: BudgetBreach;
      readonly detail: string;
      /** Calls made before the breach. */
      readonly calls: number;
      readonly spent: Paise;
    };

export interface ModelBudget {
  readonly limits: BudgetLimits;
  /** Calls that have actually been made. */
  readonly calls: number;
  readonly spent: Paise;

  /**
   * May another call be made?
   *
   * Consulted BEFORE the call. Returns a breach rather than throwing, because the caller has
   * something specific to do with it — halt the batch and write an audit row naming the
   * ceiling — and an exception thrown from inside a concurrency pool is the wrong shape for
   * that.
   */
  reserve(): Reservation;

  /** Record what a completed call cost. */
  settle(cost: Paise): void;

  /** True once either ceiling has been reached. Cheap to poll inside a loop. */
  exhausted(): boolean;
}

export function createModelBudget(limits: BudgetLimits): ModelBudget {
  if (!Number.isInteger(limits.maxCalls) || limits.maxCalls < 0) {
    throw new RangeError(`maxCalls must be a non-negative integer, got ${limits.maxCalls}`);
  }

  let calls = 0;
  let spent: Paise = ZERO;

  const budget: ModelBudget = {
    limits,

    get calls() {
      return calls;
    },
    get spent() {
      return spent;
    },

    reserve() {
      if (calls >= limits.maxCalls) {
        return {
          kind: 'breach',
          rule: 'call_ceiling',
          detail:
            `Model call ceiling reached: ${calls} of ${limits.maxCalls} permitted per batch. ` +
            `Halting rather than continuing — an agent that keeps calling until the work runs ` +
            `out is bounded by the size of the batch, which is not a budget.`,
          calls,
          spent,
        };
      }

      // Refused once spend has REACHED the cap, not once it has passed it — so the ceiling
      // is a ceiling rather than a target.
      if (gte(spent, limits.maxCostPaise)) {
        return {
          kind: 'breach',
          rule: 'cost_ceiling',
          detail:
            `Model spend ceiling reached: ${formatINR(spent)} of ` +
            `${formatINR(limits.maxCostPaise)} permitted per batch. The cost of a call is ` +
            `known only once it returns, so the overshoot is bounded to one call rather ` +
            `than to zero.`,
          calls,
          spent,
        };
      }

      return { kind: 'ok' };
    },

    settle(cost) {
      calls += 1;
      spent = add(spent, cost);
    },

    exhausted() {
      return budget.reserve().kind === 'breach';
    },
  };

  return budget;
}
